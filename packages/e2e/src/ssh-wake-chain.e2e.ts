// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { workspace, type WorkspaceDto } from "@edd/api-contracts";
import { dynamodb } from "@edd/config";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock, workspacePrincipal } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeBaseImageEntity } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostReachableTarget } from "./docker-host";
import { devHeaders, startWebApp, type WebApp } from "./web-app";

/**
 * Wake-on-connect chain e2e against the REAL control plane (no stub):
 *
 *   ssh client → gateway proxy container (ForceCommand wake-and-forward.sh)
 *     → POST /connect + GET /:id + GET /connect-info on the production-built
 *       `apps/web` (HMAC gateway machine-auth, DynamoDB Local persistence)
 *     → nc forward to the workspace node's sshd (docker-compose.ssh.yml)
 *
 * The workspace is STOPPED before the connection, so the chain only succeeds
 * if the gateway's API calls genuinely wake it (snapshot → running) first.
 * The user's certificate comes from the real POST /ssh-cert route.
 *
 * The component-level proxy test (stub control plane) lives in
 * services/ssh-gateway; this one proves the gateway↔control-plane contract.
 */

const TABLE = "ecs-dev-desktop-ssh-wake-chain-e2e";
const GATEWAY_SECRET = "c".repeat(64); // 32 bytes hex
const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";
const PROXY_PORT = "2224"; // 2222 = workspace node, 2223 = stub-CP proxy test
const COMPOSE_NETWORK = "ecs-dev-desktop_default";
const WORKSPACE_NODE = "edd-workspace-node";
const NODE_IMAGE = "golden/node:20";
const OWNER = "wake-chain-user";

const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");
const CA_KEY = join(SSH_CA_DIR, "ca");
const CA_PUB = join(SSH_CA_DIR, "ca.pub");
const USER_KEY = join(SSH_CA_DIR, "wake-chain-id");

const CMD_TIMEOUT_MS = 30_000;

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

function run(
  cmd: string,
  args: string[],
  timeout = CMD_TIMEOUT_MS,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Provision the dev-<wsId> OS login in a container (production uses NSS modules). */
function provisionPrincipal(container: string, principal: string, withPrincipalsFile: boolean) {
  const cmds = [
    `useradd --create-home --shell /bin/bash ${principal}`,
    `usermod -p '*' ${principal}`,
    ...(withPrincipalsFile
      ? [`printf '%s\\n' ${principal} > /etc/ssh/principals/${principal}`]
      : []),
  ].join(" && ");
  const res = run("docker", ["exec", container, "sh", "-c", cmds]);
  if (res.status !== 0) throw new Error(`provision ${principal} in ${container}: ${res.stderr}`);
}

describe("SSH wake-on-connect chain against the real control plane", { timeout: 300_000 }, () => {
  let web: WebApp;
  let wsId = "";
  let principal = "";
  let proxyContainerId = "";

  async function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${web.baseUrl}/api${path}`, {
      headers: devHeaders(OWNER, "member"),
      ...init,
    });
  }

  beforeAll(async () => {
    // Fresh table + catalog seed for the real control plane.
    const client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
    await new CatalogService({
      baseImages: makeBaseImageEntity(client, TABLE),
      clock: systemClock,
    }).create({ name: "Node 20", image: baseImage(NODE_IMAGE) });

    web = await startWebApp(() => ({
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? dynamodb.endpoint,
      DYNAMODB_TABLE: TABLE,
      EDD_GATEWAY_SECRET: GATEWAY_SECRET,
      EDD_SSH_CA_KEY_PATH: CA_KEY,
      // Fake compute records no ENI; point connect-info at the harness node.
      EDD_FAKE_SSH_HOST: WORKSPACE_NODE,
    }));

    // Create the workspace through the real API, as a member.
    const created = await api("/workspaces", {
      method: "POST",
      body: JSON.stringify({ baseImage: NODE_IMAGE }),
    });
    expect(created.status).toBe(201);
    const ws: WorkspaceDto = workspace.parse(await created.json());
    wsId = ws.id;
    principal = workspacePrincipal(wsId);

    // Real SSH cert issuance: the control plane signs the user's public key.
    for (const f of [USER_KEY, `${USER_KEY}.pub`, `${USER_KEY}-cert.pub`])
      rmSync(f, { force: true });
    const keygen = run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", USER_KEY]);
    expect(keygen.status, keygen.stderr).toBe(0);
    const certRes = await api(`/workspaces/${wsId}/ssh-cert`, {
      method: "POST",
      body: JSON.stringify({ publicKey: readFileSync(`${USER_KEY}.pub`, "utf8") }),
    });
    expect(certRes.status).toBe(200);
    const { cert } = (await certRes.json()) as { cert: string };
    writeFileSync(`${USER_KEY}-cert.pub`, cert);

    // Scale to zero so the gateway MUST wake it for the chain to work.
    expect((await api(`/workspaces/${wsId}/stop`, { method: "POST" })).status).toBe(200);

    // Gateway proxy container on the harness network, pointed at the real CP.
    const port = new URL(web.baseUrl).port;
    const target = hostReachableTarget(PROXY_IMAGE);
    const docker = run("docker", [
      "run",
      "-d",
      "-p",
      `${PROXY_PORT}:22`,
      "--network",
      COMPOSE_NETWORK,
      ...target.dockerArgs,
      "-v",
      `${CA_PUB}:/etc/ssh/workspace-ca.pub:ro`,
      "-e",
      `EDD_CONTROL_PLANE_URL=http://${target.host}:${port}`,
      "-e",
      `EDD_GATEWAY_SECRET=${GATEWAY_SECRET}`,
      PROXY_IMAGE,
    ]);
    if (docker.status !== 0) throw new Error(`docker run failed: ${docker.stderr}`);
    proxyContainerId = docker.stdout.trim();

    // The login user must exist where sshd authenticates it.
    provisionPrincipal(proxyContainerId, principal, false);
    provisionPrincipal(WORKSPACE_NODE, principal, true);

    // Wait for the proxy sshd to accept TCP.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (run("nc", ["-zw1", "localhost", PROXY_PORT], 3_000).status === 0) break;
      if (Date.now() > deadline) throw new Error("proxy sshd never came up");
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  afterAll(async () => {
    if (proxyContainerId) run("docker", ["rm", "-f", proxyContainerId]);
    web.stop();
    await dropTable(createDynamoClient(), TABLE);
  });

  it("SSH through the gateway wakes the stopped workspace and reaches the node", async () => {
    // Sanity: the workspace is stopped before the connection.
    const before = workspace.parse(await (await api(`/workspaces/${wsId}`)).json());
    expect(before.state).toBe("stopped");

    // Inner leg: a normal SSH session to the gateway — sshd runs the ForceCommand
    // (wake-and-forward.sh), which calls the REAL control plane and then bridges
    // stdio to the workspace node. The outer ssh speaks the SSH protocol through
    // that bridge and authenticates to the workspace node with the same cert.
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
      `${principal}@localhost`,
    ].join(" ");

    const res = run(
      "ssh",
      [
        "-i",
        USER_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        `ProxyCommand=${innerCmd}`,
        "-o",
        "ConnectTimeout=15",
        `${principal}@${WORKSPACE_NODE}`,
        "whoami",
      ],
      60_000,
    );
    expect(res.status, `chain SSH failed:\n${res.stdout}${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe(principal);

    // The wake really happened through the gateway's machine-auth API calls.
    const after = workspace.parse(await (await api(`/workspaces/${wsId}`)).json());
    expect(after.state).toBe("running");
  });
});
