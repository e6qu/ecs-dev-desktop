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
 *  - workspace SSH node (docker-compose.ssh.yml, localhost:2222)
 *  - SSH proxy container (edd-ssh-proxy:e2e, launched here via docker run, port 2223)
 *  - stub control plane HTTP server (in-process, port assigned by OS)
 *
 * Flow:
 *  1. Client SSHes to proxy (ProxyCommand pattern):
 *       outer ssh  →  inner ssh -p 2223 dev-e2e@localhost
 *                      → ForceCommand wake-and-forward.sh
 *                         → curl stub/connect, curl stub/connect-info
 *                         → exec nc host.docker.internal 2222
 *  2. Outer ssh authenticates to workspace sshd through the nc tunnel.
 *  3. Verifies `whoami` returns "dev-e2e".
 *
 * The stub returns `host.docker.internal:2222` as the workspace SSH endpoint.
 * `host.docker.internal` resolves to the Docker host from inside the proxy container,
 * giving the proxy nc access to the workspace node on the mapped port 2222.
 *
 * The proxy-to-workspace forwarding over real VPC ENI IPs is proven separately via the
 * workspace-lifecycle e2e (sshHost assertion) — that test proves the IP is set and in the
 * VPC CIDR; the sockerless #518 TestECSVPCNetworking proves intra-VPC TCP routability.
 */

const PRINCIPAL = workspacePrincipal("e2e"); // "dev-e2e"
const PROXY_PORT = "2223";
const GATEWAY_TOKEN = "edd-test-token";

const TEMP = join(import.meta.dirname, "../../..", "services/ssh-gateway/temp/ssh-ca");
const CA_PUB_KEY = join(TEMP, "ca.pub");
const USER_KEY = join(TEMP, "proxy-e2e-id");

const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";

let proxyContainerId = "";
let stubPort = 0;
let stubServer: ReturnType<typeof createServer>;

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
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

      // Start the stub control plane.
      // The proxy container accesses the host via host.docker.internal.
      stubPort = await startStub("host.docker.internal", 2222);

      // Launch the proxy container.
      const docker = run("docker", [
        "run",
        "-d",
        "-p",
        `${PROXY_PORT}:22`,
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

      // Wait for the proxy sshd to accept connections (up to 15 s).
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const probe = ssh(
          "-p",
          PROXY_PORT,
          "-o",
          "ConnectTimeout=1",
          `${PRINCIPAL}@localhost`,
          "exit 0 || true",
        );
        if (probe.status === 0 || probe.stderr.includes("Permission denied")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    afterAll(() => {
      if (proxyContainerId) run("docker", ["rm", "-f", proxyContainerId]);
      stubServer.close();
    });

    it("SSHes through the gateway proxy to the workspace node and back", () => {
      // Use ssh ProxyCommand: outer ssh connects via the proxy's ForceCommand nc tunnel.
      // The proxy ForceCommand calls the stub control plane to get the workspace
      // SSH endpoint (host.docker.internal:2222 = the workspace node).
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
        "-tt",
        `${PRINCIPAL}@proxy-target`, // host is irrelevant — ProxyCommand provides the transport
        "whoami",
      );
      expect(res.status, `proxy SSH failed:\n${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe(PRINCIPAL);
    });
  },
);
