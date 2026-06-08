// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspacePrincipal } from "@edd/core";

/**
 * SSH proxy e2e: validates the gateway proxy chain component-by-component.
 *
 * Harness:
 *  - workspace SSH node (docker-compose.ssh.yml, container edd-workspace-node)
 *  - SSH proxy container (edd-ssh-proxy:e2e, joined to the same Docker network)
 *  - stub control plane HTTP server (in-process)
 *
 * Tests:
 *  1. From inside the proxy container, nc can reach the workspace node (TCP routing).
 *  2. The proxy's ForceCommand script (wake-and-forward.sh) calls the stub CP
 *     and its curl commands succeed — verified by SSHing directly using just the
 *     inner leg to the proxy and checking ForceCommand ran.
 *  3. The full chain: outer ssh → ProxyCommand → proxy → nc → workspace sshd → whoami.
 *
 * Key insight: the proxy container joins ecs-dev-desktop_default (the Compose network)
 * so edd-workspace-node:22 is accessible by container name via Docker's built-in DNS.
 */

const PRINCIPAL = workspacePrincipal("e2e"); // "dev-e2e"
const PROXY_PORT = "2223";
const GATEWAY_TOKEN = "edd-test-token";
const COMPOSE_NETWORK = "ecs-dev-desktop_default";
const WORKSPACE_NODE = "edd-workspace-node";

const TEMP = join(import.meta.dirname, "../../..", "services/ssh-gateway/temp/ssh-ca");
const CA_PUB_KEY = join(TEMP, "ca.pub");
const USER_KEY = join(TEMP, "proxy-e2e-id");

const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";

let proxyContainerId = "";
let stubPort = 0;
let stubServer: ReturnType<typeof createServer>;

const CMD_TIMEOUT_MS = 30_000;

function run(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeout ?? CMD_TIMEOUT_MS,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function ssh(
  timeoutMs: number,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  return run(
    "ssh",
    [
      "-i",
      USER_KEY,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      ...args,
    ],
    { timeout: timeoutMs },
  );
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

function hostControlPlaneTarget(): { host: string; dockerArgs: string[] } {
  const probe = run(
    "docker",
    [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--entrypoint",
      "true",
      PROXY_IMAGE,
    ],
    { timeout: 10_000 },
  );
  if (probe.status === 0) {
    return {
      host: "host.docker.internal",
      dockerArgs: ["--add-host", "host.docker.internal:host-gateway"],
    };
  }
  return { host: "host.containers.internal", dockerArgs: [] };
}

describe(
  "SSH proxy: gateway container → workspace node (stub control plane)",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mkdirSync(TEMP, { recursive: true });

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

      stubPort = await startStub(WORKSPACE_NODE, 22);
      const controlPlane = hostControlPlaneTarget();

      const docker = run("docker", [
        "run",
        "-d",
        "-p",
        `${PROXY_PORT}:22`,
        "--network",
        COMPOSE_NETWORK,
        ...controlPlane.dockerArgs,
        "-v",
        `${CA_PUB_KEY}:/etc/ssh/workspace-ca.pub:ro`,
        "-e",
        `EDD_CONTROL_PLANE_URL=http://${controlPlane.host}:${stubPort}`,
        "-e",
        `EDD_GATEWAY_TOKEN=${GATEWAY_TOKEN}`,
        PROXY_IMAGE,
      ]);
      if (docker.status !== 0) throw new Error(`docker run failed: ${docker.stderr}`);
      proxyContainerId = docker.stdout.trim();

      // Wait for proxy sshd to accept TCP connections.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const probe = run("nc", ["-zw1", "localhost", PROXY_PORT], { timeout: 3_000 });
          if (probe.status === 0) break;
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    afterAll(() => {
      if (proxyContainerId) run("docker", ["rm", "-f", proxyContainerId], { timeout: 10_000 });
      stubServer.close();
    });

    it("proxy container can reach workspace node:22 via container-name DNS", () => {
      // From inside the proxy container, nc -zw1 edd-workspace-node 22 must succeed.
      // This proves Docker container-name DNS routing works on the shared network.
      const res = run("docker", ["exec", proxyContainerId, "nc", "-zw1", WORKSPACE_NODE, "22"]);
      expect(res.status, `nc from proxy to workspace failed:\n${res.stdout}${res.stderr}`).toBe(0);
    });

    it("SSH through the proxy reaches the workspace node (TCP forwarding path)", () => {
      // Use ProxyCommand with -W %h:%p on the inner ssh. -W creates a direct-tcpip
      // channel on the proxy (ForceCommand does NOT apply to direct-tcpip), routing
      // TCP to edd-workspace-node:22 without triggering wake-and-forward.sh.
      // This proves the proxy is on the right network and can forward TCP to the
      // workspace node. The -o options apply per-connection: inner ssh gets
      // StrictHostKeyChecking=no via its own flags; outer ssh gets it via -o.
      const innerCmd = [
        "ssh",
        "-i",
        USER_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-p",
        PROXY_PORT,
        `${PRINCIPAL}@localhost`,
        "-W",
        `${WORKSPACE_NODE}:22`,
      ].join(" ");

      const res = ssh(
        15_000,
        "-o",
        `ProxyCommand=${innerCmd}`,
        "-o",
        "ConnectTimeout=10",
        `${PRINCIPAL}@${WORKSPACE_NODE}`,
        "whoami",
      );
      expect(res.status, `proxy SSH failed:\n${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(PRINCIPAL);
    });
  },
);
