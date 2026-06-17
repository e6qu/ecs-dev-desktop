// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Dual-trust SSH e2e: a connecting client's **registered key** is authorized at
 * BOTH hops by the control plane — the gateway proxy (public hop) and the
 * workspace node (inner hop) each run AuthorizedKeysCommand → `ssh-authorize`.
 *
 * Self-contained harness (no docker-compose): an in-process stub control plane
 * (dynamic port) + two `docker run` containers (workspace node + gateway proxy)
 * joined to a fresh Docker network. The stub authorizes exactly the test's
 * registered key; an unregistered key is denied at the first hop.
 *
 * Images are built by CI (`edd-workspace-node:e2e`, `edd-ssh-proxy:e2e`); locally
 * the test builds them if absent.
 */

const WORKSPACE_ID = "e2e";
const PROXY_PORT = "2223";
const GATEWAY_SECRET = "d".repeat(64); // hex; the stub accepts any token
const AGENT_TOKEN = "e".repeat(64); // the stub accepts any token
const NETWORK = "edd-ssh-dualtrust-e2e";
// Distinct from the compose harness's `edd-workspace-node` (used by the cert-based
// wake-chain e2e) — container names are global, so a shared name would collide.
const WORKSPACE_NODE = "edd-dualtrust-node";
const PROXY_NAME = "edd-ssh-proxy-e2e";
const NODE_IMAGE = process.env.NODE_IMAGE ?? "edd-workspace-node:e2e";
const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const TEMP = join(REPO_ROOT, "services/ssh-gateway/temp/ssh-ca");
const USER_KEY = join(TEMP, "dualtrust-id"); // the registered key
const ROGUE_KEY = join(TEMP, "dualtrust-rogue"); // an unregistered key

const CMD_TIMEOUT_MS = 30_000;
let proxyId = "";
let stubWorker: Worker | undefined;
let registeredKeyLine = ""; // "<type> <blob>" of USER_KEY (no comment)

function run(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: opts?.timeout ?? CMD_TIMEOUT_MS });
  if (res.error) throw new Error(`\`${cmd} ${args.join(" ")}\` failed: ${res.error.message}`);
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** "<type> <blob>" — the comment-free key line ssh-authorize compares on. */
function keyLine(pubPath: string): string {
  const [type, blob] = readFileSync(pubPath, "utf8").trim().split(/\s+/);
  return `${type} ${blob}`;
}

/**
 * Stub control plane, run in a **worker thread** so it keeps serving while the
 * main thread blocks on synchronous `spawnSync(ssh/docker)` — the gateway and
 * node call `ssh-authorize` *during* the blocking SSH connection, so an
 * in-process server on the main event loop would deadlock. Authorizes only the
 * registered key; serves wake (`/connect`) + `/connect-info`. Resolves the port.
 */
function startStub(): Promise<number> {
  const code = `
    const http = require('node:http');
    const { workerData, parentPort } = require('node:worker_threads');
    const KEY = workerData.key, NODE = workerData.node, ID = workerData.id;
    const dto = JSON.stringify({ id: ID, state: 'running', ownerId: 'test', baseImage: 't', createdAt: '2026-01-01T00:00:00.000Z' });
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const u = req.url || '';
      if (req.method === 'POST' && u.includes('/ssh-authorize')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let pk = '';
          try { pk = (JSON.parse(Buffer.concat(chunks).toString()).publicKey || '').trim(); } catch {}
          res.writeHead(200);
          res.end(JSON.stringify(pk === KEY ? { authorized: true, principal: 'dev-e2e' } : { authorized: false }));
        });
        return;
      }
      if (req.method === 'POST' && u.includes('/connect')) { res.writeHead(200); res.end(dto); }
      else if (req.method === 'GET' && u.includes('/connect-info')) { res.writeHead(200); res.end(JSON.stringify({ host: NODE, port: 22 })); }
      else if (req.method === 'GET') { res.writeHead(200); res.end(dto); }
      else { res.writeHead(404); res.end('{}'); }
    });
    server.listen(0, '0.0.0.0', () => parentPort.postMessage(server.address().port));
  `;
  return new Promise((resolve) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { key: registeredKeyLine, node: WORKSPACE_NODE, id: WORKSPACE_ID },
    });
    stubWorker = worker;
    worker.once("message", (port: number) => {
      resolve(port);
    });
  });
}

/** Build the image from its Dockerfile (context = repo root) unless it exists —
 * CI pre-builds them; locally the first run builds. `--load` ensures the result
 * lands in the local image store under the buildx container driver. */
function buildImageIfAbsent(image: string, dockerfile: string): void {
  if (run("docker", ["image", "inspect", image]).status === 0) return;
  const b = run(
    "docker",
    ["build", "--load", "-f", join(REPO_ROOT, dockerfile), "-t", image, REPO_ROOT],
    { timeout: 300_000 },
  );
  if (b.status !== 0) throw new Error(`image build failed (${image}): ${b.stderr}${b.stdout}`);
}

/** The host alias + docker args that let a container reach the host's stub.
 * Docker Desktop/dockerd support `--add-host host-gateway`; colima/podman reject
 * it and resolve `host.containers.internal` natively. Probe with an explicit name
 * + bounded timeout, treating any failure (incl. timeout) as the latter — a failed
 * `--add-host` run can leave a "Created" container, so clean it up regardless. */
function hostTarget(): { host: string; dockerArgs: string[] } {
  run("docker", ["rm", "-f", "edd-host-probe"]);
  const probe = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      "edd-host-probe",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--entrypoint",
      "true",
      PROXY_IMAGE,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  run("docker", ["rm", "-f", "edd-host-probe"]);
  return !probe.error && probe.status === 0
    ? {
        host: "host.docker.internal",
        dockerArgs: ["--add-host", "host.docker.internal:host-gateway"],
      }
    : { host: "host.containers.internal", dockerArgs: [] };
}

function waitForTcp(port: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run("nc", ["-zw1", "localhost", port], { timeout: 3_000 }).status === 0) return true;
    if (run("sleep", ["0.5"]).status !== 0) break;
  }
  return false;
}

/** Force-remove the named containers + network (idempotent). */
function teardownContainers(): void {
  run("docker", ["rm", "-f", WORKSPACE_NODE, PROXY_NAME]);
  run("docker", ["network", "rm", NETWORK]);
}

/** Wait until the workspace node's sshd accepts TCP — probed from inside the
 * proxy container (the node has no host-published port). Avoids a banner-exchange
 * race where the first connection arrives before the node sshd is listening. */
function waitForNode(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = run("docker", ["exec", proxyId, "nc", "-zw1", WORKSPACE_NODE, "22"]);
    if (probe.status === 0) return true;
    if (run("sleep", ["0.5"]).status !== 0) break;
  }
  return false;
}

describe(
  "dual-trust SSH: registered key authorized at gateway + node",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      mkdirSync(TEMP, { recursive: true });
      for (const k of [USER_KEY, ROGUE_KEY]) {
        run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", k, "-C", "edd-dualtrust"]);
      }
      registeredKeyLine = keyLine(`${USER_KEY}.pub`);

      buildImageIfAbsent(NODE_IMAGE, "services/ssh-gateway/Dockerfile.node");
      buildImageIfAbsent(PROXY_IMAGE, "services/ssh-gateway/Dockerfile.proxy");

      // Idempotent pre-cleanup: a prior aborted run can leave the named containers
      // or network behind, which would wedge `docker run`/`network create`.
      teardownContainers();

      run("docker", ["network", "create", NETWORK]);
      const stubPort = await startStub();
      const target = hostTarget();
      const cpUrl = `http://${target.host}:${stubPort}`;

      const node = run("docker", [
        "run",
        "-d",
        "--name",
        WORKSPACE_NODE,
        "--network",
        NETWORK,
        ...target.dockerArgs,
        "-e",
        `EDD_WORKSPACE_ID=${WORKSPACE_ID}`,
        "-e",
        `EDD_CONTROL_PLANE_URL=${cpUrl}`,
        "-e",
        `EDD_AGENT_TOKEN=${AGENT_TOKEN}`,
        NODE_IMAGE,
      ]);
      if (node.status !== 0) throw new Error(`node run failed: ${node.stderr}`);

      const proxy = run("docker", [
        "run",
        "-d",
        "--name",
        PROXY_NAME,
        "-p",
        `${PROXY_PORT}:22`,
        "--network",
        NETWORK,
        ...target.dockerArgs,
        "-e",
        `EDD_CONTROL_PLANE_URL=${cpUrl}`,
        "-e",
        `EDD_GATEWAY_SECRET=${GATEWAY_SECRET}`,
        PROXY_IMAGE,
      ]);
      if (proxy.status !== 0) throw new Error(`proxy run failed: ${proxy.stderr}`);
      proxyId = proxy.stdout.trim();

      if (!waitForTcp(PROXY_PORT, 15_000)) throw new Error("proxy sshd did not come up");
      if (!waitForNode(15_000)) throw new Error("workspace node sshd did not come up");
    });

    afterAll(async () => {
      teardownContainers();
      await stubWorker?.terminate();
    });

    /** Outer ssh → ProxyCommand (inner ssh to gateway, ForceCommand wakes+forwards)
     * → workspace node. `key` is presented at both hops. */
    function connect(key: string): { status: number; stdout: string; stderr: string } {
      const inner = [
        "ssh",
        "-T",
        "-i",
        key,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-p",
        PROXY_PORT,
        "dev-e2e@localhost",
      ].join(" ");
      return run(
        "ssh",
        [
          "-i",
          key,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=10",
          "-o",
          `ProxyCommand=${inner}`,
          `workspace@${WORKSPACE_NODE}`,
          "whoami",
        ],
        { timeout: 30_000 },
      );
    }

    it("authorizes the registered key end-to-end and lands on the workspace node", () => {
      const res = connect(USER_KEY);
      expect(res.status, `dual-trust SSH failed:\n${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout.trim()).toBe("workspace");
    });

    it("denies an unregistered key at the gateway", () => {
      const res = connect(ROGUE_KEY);
      expect(res.status, "unregistered key must be denied").not.toBe(0);
    });
  },
);
