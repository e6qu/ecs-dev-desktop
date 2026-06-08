// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspacePrincipal } from "@edd/core";

/**
 * SSH proxy e2e: client → gateway proxy container → workspace SSH node.
 *
 * Harness:
 *  - workspace SSH node (docker-compose.ssh.yml, container name edd-workspace-node)
 *  - SSH proxy container (edd-ssh-proxy:e2e, joined to the same Docker network, port 2223)
 *  - stub control plane HTTP server (in-process, bound on 0.0.0.0)
 *
 * The proxy container joins the docker-compose.ssh.yml default network
 * (ecs-dev-desktop_default) so it can reach edd-workspace-node:22 by container name.
 * The stub runs on the host; the proxy container reaches it at host.docker.internal:<port>.
 *
 * Flow:
 *  1. Client SSHes to proxy using ProxyCommand (inner ssh → proxy → ForceCommand):
 *       outer ssh -o ProxyCommand="ssh -p 2223 dev-e2e@localhost" dev-e2e@target
 *       → proxy ForceCommand: wake-and-forward.sh
 *          → curl stub/connect → 200
 *          → curl stub/connect-info → {host:"edd-workspace-node", port:22}
 *          → exec nc edd-workspace-node 22
 *  2. Outer ssh authenticates to workspace sshd through the nc TCP tunnel.
 *  3. `whoami` returns "dev-e2e".
 *
 * The proxy-to-workspace forwarding over real VPC ENI IPs is proven separately via the
 * workspace-lifecycle e2e (sshHost assertion + sockerless #518 TestECSVPCNetworking).
 */

const PRINCIPAL = workspacePrincipal("e2e"); // "dev-e2e"
const PROXY_PORT = "2223";
const GATEWAY_TOKEN = "edd-test-token";
// Docker Compose project default network (project name = directory name).
const COMPOSE_NETWORK = "ecs-dev-desktop_default";
// Workspace SSH node container name (from docker-compose.ssh.yml).
const WORKSPACE_NODE = "edd-workspace-node";

const TEMP = join(import.meta.dirname, "../../..", "services/ssh-gateway/temp/ssh-ca");
const CA_PUB_KEY = join(TEMP, "ca.pub");
const USER_KEY = join(TEMP, "proxy-e2e-id");

const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";

let proxyContainerId = "";
let stubPort = 0;
let stubServer: ReturnType<typeof createServer>;

const SSH_TIMEOUT_MS = 30_000;

function run(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeout ?? SSH_TIMEOUT_MS,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function ssh(...args: string[]): { status: number; stdout: string; stderr: string } {
  return run("ssh", [
    "-i",
    USER_KEY,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    ...args,
  ]);
}

function startStub(workspaceHost: string, workspacePort: number): Promise<number> {
  return new Promise((resolve) => {
    stubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("content-type", "application/json");
      const wsDto = JSON.stringify({
        id: "e2e",
        state: "running",
        ownerId: "test",
        baseImage: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      if (req.method === "POST" && req.url?.includes("/connect")) {
        res.writeHead(200);
        res.end(wsDto);
      } else if (req.method === "GET" && req.url?.includes("/connect-info")) {
        res.writeHead(200);
        res.end(JSON.stringify({ host: workspaceHost, port: workspacePort }));
      } else if (req.method === "GET") {
        res.writeHead(200);
        res.end(wsDto);
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    stubServer.listen(0, "0.0.0.0", () => {
      const addr = stubServer.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

describe(
  "SSH proxy: client → gateway container → workspace node (stub control plane)",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mkdirSync(TEMP, { recursive: true });

      // Generate a per-run user key pair + cert signed by the workspace CA.
      run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", USER_KEY, "-C", "edd-proxy-e2e"]);
      const signed = run("ssh-keygen", [
        "-s",
        join(TEMP, "ca"),
        "-I",
        "edd-proxy-e2e-tester",
        "-n",
        PRINCIPAL,
        "-V",
        "+1h",
        `${USER_KEY}.pub`,
      ]);
      if (signed.status !== 0) throw new Error(`cert sign failed: ${signed.stderr}`);

      // Start the stub control plane. Bound on 0.0.0.0 so the proxy container can
      // reach it via host.docker.internal. The stub returns edd-workspace-node:22 as
      // the SSH endpoint — accessible by container name on the shared Docker network.
      stubPort = await startStub(WORKSPACE_NODE, 22);

      // Launch the proxy container, joined to the Compose network so it can reach
      // edd-workspace-node by container name.
      const docker = run("docker", [
        "run",
        "-d",
        "-p",
        `${PROXY_PORT}:22`,
        "--network",
        COMPOSE_NETWORK,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        `${CA_PUB_KEY}:/etc/ssh/workspace-ca.pub:ro`,
        "-e",
        `EDD_CONTROL_PLANE_URL=http://host.docker.internal:${stubPort}`,
        "-e",
        `EDD_GATEWAY_TOKEN=${GATEWAY_TOKEN}`,
        PROXY_IMAGE,
      ]);
      if (docker.status !== 0) throw new Error(`docker run failed: ${docker.stderr}`);
      proxyContainerId = docker.stdout.trim();

      // Wait for the proxy sshd TCP port to be open (up to 15 s).
      // Use nc -zw1 (TCP-only probe, no SSH handshake) so we don't trigger the
      // ForceCommand (which would run nc → workspace sshd and block for 30 s).
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const probe = run("nc", ["-zw1", "localhost", PROXY_PORT], { timeout: 3_000 });
          if (probe.status === 0) break;
        } catch {
          // nc not yet reachable — retry
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    afterAll(() => {
      if (proxyContainerId) run("docker", ["rm", "-f", proxyContainerId], { timeout: 10_000 });
      stubServer.close();
    });

    it("SSHes through the gateway proxy to the workspace node and back", () => {
      // ProxyCommand connects to the proxy container. The proxy ForceCommand
      // (wake-and-forward.sh) calls the stub CP, gets edd-workspace-node:22,
      // and execs nc — providing a raw TCP tunnel to the workspace sshd.
      // The outer ssh authenticates to the workspace sshd through this tunnel.
      const innerProxy = [
        "ssh",
        "-i",
        USER_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        PROXY_PORT,
        `${PRINCIPAL}@localhost`,
      ].join(" ");

      const res = ssh(
        "-o",
        `ProxyCommand=${innerProxy}`,
        `${PRINCIPAL}@${WORKSPACE_NODE}`, // outer destination — host is irrelevant (ProxyCommand provides transport)
        "whoami",
      );
      expect(res.status, `proxy SSH failed:\n${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(PRINCIPAL);
    });
  },
);
