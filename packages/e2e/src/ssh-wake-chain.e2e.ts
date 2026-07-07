// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  workspace,
  workspaceInspection,
  type WorkspaceDetailDto,
  type WorkspaceDto,
} from "@edd/api-contracts";
import { dynamodb } from "@edd/config";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock, workspacePrincipal } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeBaseImageEntity } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sleep } from "./aws-sim";
import { hostReachableTarget } from "./docker-host";
import { devHeaders, startWebApp, type WebApp } from "./web-app";

/**
 * Wake-on-connect chain e2e against the REAL control plane (no stub):
 *
 *   ssh client (registered key) → gateway proxy container
 *     → AuthorizedKeysCommand → POST /ssh-authorize (the key is registered to the
 *       workspace's owner) → sshd accepts → ForceCommand wake-and-forward.sh
 *     → POST /connect + GET /:id + GET /connect-info on the production-built
 *       `apps/web` (HMAC gateway machine-auth, DynamoDB Local persistence)
 *
 * The workspace is STOPPED before the connection, so it only reaches "running" if
 * the gateway's machine-auth API calls genuinely wake it. This proves the
 * gateway↔control-plane contract end to end; landing a shell on a workspace node
 * is covered by services/ssh-gateway/src/ssh-proxy.e2e.ts.
 */

const TABLE = `ecs-dev-desktop-ssh-wake-chain-e2e-${randomUUID()}`;
const GATEWAY_SECRET = "c".repeat(64); // 32 bytes hex
const PROXY_IMAGE = process.env.PROXY_IMAGE ?? "edd-ssh-proxy:e2e";
const PROXY_PORT = "2224";
const NODE_IMAGE = "golden/node:20";
const OWNER = "wake-chain-user";
// The fake compute records no ENI; connect-info points the gateway here. nc to it
// fails (no real node), but the wake already happened by then — which is the assertion.
const FAKE_SSH_HOST = "192.0.2.2"; // TEST-NET-1, unreachable

const USER_KEY = join(
  import.meta.dirname,
  "../../../services/ssh-gateway/temp/ssh-ca",
  "wake-chain-id",
);
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

describe("SSH wake-on-connect chain against the real control plane", { timeout: 300_000 }, () => {
  let web: WebApp;
  let wsId = "";
  let principal = "";
  let proxyContainerId = "";

  async function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${web.baseUrl}/api${path}`, { headers: devHeaders(OWNER, "member"), ...init });
  }

  async function inspect(): Promise<WorkspaceDetailDto> {
    const res = await fetch(`${web.baseUrl}/api/admin/workspaces/${wsId}`, {
      headers: devHeaders("root", "admin"),
    });
    expect(res.status).toBe(200);
    return workspaceInspection.parse(await res.json()).workspace;
  }

  beforeAll(async () => {
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
      EDD_FAKE_SSH_HOST: FAKE_SSH_HOST,
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
    const createDeadline = Date.now() + 120_000;
    for (;;) {
      const cur = await inspect();
      if (cur.state === "running") {
        expect(cur.taskId).toBeDefined();
        expect(cur.volumeId).toBeDefined();
        break;
      }
      if (Date.now() > createDeadline) {
        throw new Error(`create never converged (state: ${cur.state})`);
      }
      await sleep(2_000);
    }

    // Register the connecting client's SSH key for the workspace owner; the gateway
    // authorizes it via the control plane's ssh-authorize.
    mkdirSync(dirname(USER_KEY), { recursive: true });
    for (const f of [USER_KEY, `${USER_KEY}.pub`]) rmSync(f, { force: true });
    expect(run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", USER_KEY]).status).toBe(0);
    const reg = await api("/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ publicKey: readFileSync(`${USER_KEY}.pub`, "utf8").trim() }),
    });
    expect(reg.status).toBe(201);

    // Take a resume snapshot through the same API/server path that created the
    // fake volume, then scale to zero so the gateway MUST wake it for the chain
    // to work. The custom-server stop sweep is a separate module instance in this
    // harness; production EBS storage is shared, but the in-memory fake is not.
    expect((await api(`/workspaces/${wsId}/snapshot`, { method: "POST" })).status).toBe(200);
    expect((await inspect()).latestSnapshotId).toMatch(/^snap-/);

    // Manual stop is cancelable now (route -> `stopping`, converger sweep ->
    // `stopped`); wait on the full detail record so the resume snapshot is
    // present before the wake.
    expect((await api(`/workspaces/${wsId}/stop`, { method: "POST" })).status).toBe(200);
    const stopDeadline = Date.now() + 60_000;
    for (;;) {
      const cur = await inspect();
      if (cur.state === "stopped" && cur.latestSnapshotId !== undefined) break;
      if (Date.now() > stopDeadline) {
        throw new Error(
          [
            "stop never converged to stopped-with-snapshot",
            `state=${cur.state}`,
            `taskId=${cur.taskId ?? "<none>"}`,
            `volumeId=${cur.volumeId ?? "<none>"}`,
            `latestSnapshotId=${cur.latestSnapshotId ?? "<none>"}`,
          ].join("\n"),
        );
      }
      await sleep(2_000);
    }

    // Gateway proxy container, pointed at the real control plane via the host alias.
    const port = new URL(web.baseUrl).port;
    const target = hostReachableTarget(PROXY_IMAGE);
    const docker = run("docker", [
      "run",
      "-d",
      "-p",
      `${PROXY_PORT}:22`,
      ...target.dockerArgs,
      "-e",
      `EDD_CONTROL_PLANE_URL=http://${target.host}:${port}`,
      "-e",
      `EDD_GATEWAY_SECRET=${GATEWAY_SECRET}`,
      PROXY_IMAGE,
    ]);
    if (docker.status !== 0) throw new Error(`docker run failed: ${docker.stderr}`);
    proxyContainerId = docker.stdout.trim();

    // The dev-<id> login user must exist where sshd authenticates it.
    const provision = run("docker", [
      "exec",
      proxyContainerId,
      "sh",
      "-c",
      `useradd --create-home --shell /bin/bash ${principal} && usermod -p '*' ${principal}`,
    ]);
    if (provision.status !== 0) throw new Error(`provision ${principal}: ${provision.stderr}`);

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
    for (const f of [USER_KEY, `${USER_KEY}.pub`]) rmSync(f, { force: true });
  });

  it("SSH with a registered key wakes the stopped workspace through the gateway", async () => {
    // Sanity: the workspace is stopped before the connection.
    const before = workspace.parse(await (await api(`/workspaces/${wsId}`)).json());
    expect(before.state).toBe("stopped");

    // Connect to the gateway as the workspace principal with the registered key.
    // sshd authorizes the key (AuthorizedKeysCommand → ssh-authorize) and runs the
    // ForceCommand, which calls the REAL control plane to wake the workspace (steps
    // 1-3 of wake-and-forward.sh) and THEN `nc`s to the fake host. That fake host is
    // an unrouteable TEST-NET address, so the nc — and thus the ssh session — never
    // returns. We run ssh ASYNC (not spawnSync, which would freeze the event loop and
    // let our own keep-alive sockets to the control plane go stale) and poll for the
    // wake; the ssh is killed once we observe it. We assert the wake, not the forward
    // (landing on a node is covered by ssh-proxy.e2e).
    const ssh = spawn(
      "ssh",
      [
        "-T",
        "-i",
        USER_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=10",
        "-p",
        PROXY_PORT,
        `${principal}@localhost`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const sshOutput: string[] = [];
    const sshErrors: string[] = [];
    ssh.stdout.setEncoding("utf8");
    ssh.stderr.setEncoding("utf8");
    ssh.stdout.on("data", (chunk: string) => sshOutput.push(chunk));
    ssh.stderr.on("data", (chunk: string) => sshErrors.push(chunk));
    let sshExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    ssh.on("exit", (code, signal) => {
      sshExit = { code, signal };
    });

    try {
      // The wake really happened through the gateway's machine-auth API calls — only
      // possible if the gateway first authorized the registered key.
      const deadline = Date.now() + 60_000;
      let state = before.state;
      while (Date.now() < deadline) {
        state = workspace.parse(await (await api(`/workspaces/${wsId}`)).json()).state;
        if (state === "running") break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      if (state !== "running") {
        const logs = run("docker", ["logs", proxyContainerId], 10_000);
        throw new Error(
          [
            "gateway must wake the stopped workspace via the real control plane",
            `state=${state}`,
            `sshExit=${JSON.stringify(sshExit)}`,
            `sshStdout=${sshOutput.join("")}`,
            `sshStderr=${sshErrors.join("")}`,
            `proxyLogs=${logs.stdout}${logs.stderr}`,
          ].join("\n"),
        );
      }
    } finally {
      ssh.kill("SIGKILL");
    }
  });
});
