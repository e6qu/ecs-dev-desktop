// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { workspacePrincipal } from "./index";

/**
 * Mock-free SSH e2e against a REAL Teleport cluster in Docker (docker-compose.ssh.yml
 * — Teleport is the real product, not a simulator). We provision a Teleport user +
 * role through `tctl`, sign a short-lived identity file, then connect with `tsh` and
 * assert the session lands on the enrolled workspace node as the principal our pure
 * `workspacePrincipal` derives. A login the role doesn't grant is denied.
 *
 * Teleport admin/client commands run inside the auth container via `docker exec`
 * (the same `tctl`/`tsh` an operator uses against a real cluster).
 */
const AUTH_CONTAINER = "edd-teleport-auth";
const NODE_NAME = "workspace-1";
const WORKSPACE_LABEL = "edd-workspace";
const PROXY_WEB_ADDR = "localhost:3080";
const TELEPORT_USER = "e2e-tester";
const TELEPORT_ROLE = "edd-ssh-e2e";
const IDENTITY_PATH = "/tmp/e2e-identity";

// The OS principal the e2e workspace node was built with (Dockerfile.node ARG).
const PRINCIPAL = workspacePrincipal("e2e");

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command inside the Teleport auth container. */
function authExec(argv: string[], input?: string): ExecResult {
  const res = spawnSync("docker", ["exec", "-i", AUTH_CONTAINER, ...argv], {
    input,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** A `tsh` invocation against the cluster using the signed identity file. */
function tsh(...args: string[]): ExecResult {
  return authExec([
    "/usr/local/bin/tsh",
    `--proxy=${PROXY_WEB_ADDR}`,
    "--insecure", // the test cluster's proxy serves a self-signed cert
    "-i",
    IDENTITY_PATH,
    ...args,
  ]);
}

function tctl(args: string[], input?: string): ExecResult {
  return authExec(["/usr/local/bin/tctl", ...args], input);
}

describe("SSH to a workspace via Teleport (mock-free, real cluster)", () => {
  beforeAll(async () => {
    // 1. Wait for the workspace node to enrol in the cluster.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const nodes = tctl(["nodes", "ls"]);
      if (nodes.stdout.includes(NODE_NAME)) break;
      if (Date.now() > deadline) {
        throw new Error(`node ${NODE_NAME} did not enrol:\n${nodes.stdout}${nodes.stderr}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 2. Provision a role granting the workspace principal on workspace nodes, and a
    //    user with that role. Tolerate re-runs (resources may already exist).
    const spec = [
      "kind: role",
      "version: v7",
      "metadata:",
      `  name: ${TELEPORT_ROLE}`,
      "spec:",
      "  allow:",
      `    logins: [${PRINCIPAL}]`,
      "    node_labels:",
      `      ${WORKSPACE_LABEL}: ['true']`,
      "---",
      "kind: user",
      "version: v2",
      "metadata:",
      `  name: ${TELEPORT_USER}`,
      "spec:",
      `  roles: [${TELEPORT_ROLE}]`,
      "",
    ].join("\n");
    const created = tctl(["create", "-f", "-"], spec);
    if (created.status !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      throw new Error(`tctl create failed:\n${created.stdout}${created.stderr}`);
    }

    // 3. Sign a short-lived identity file for that user (non-interactive auth).
    const signed = tctl([
      "auth",
      "sign",
      `--user=${TELEPORT_USER}`,
      "--format=file",
      `--out=${IDENTITY_PATH}`,
      "--ttl=1h",
      "--overwrite",
    ]);
    if (signed.status !== 0) {
      throw new Error(`tctl auth sign failed:\n${signed.stdout}${signed.stderr}`);
    }
  });

  it("connects to the workspace node as the derived principal", () => {
    const res = tsh("ssh", "--no-use-local-ssh-agent", `${PRINCIPAL}@${NODE_NAME}`, "whoami");
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe(PRINCIPAL);
  });

  it("denies a login the user's role does not grant", () => {
    const res = tsh("ssh", "--no-use-local-ssh-agent", `root@${NODE_NAME}`, "whoami");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/access denied/i);
  });
});
