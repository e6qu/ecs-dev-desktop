// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";

import { beforeAll, describe, expect, it } from "vitest";

import { workspacePrincipal } from "./index";

/**
 * Mock-free SSH e2e against a REAL Teleport cluster in Docker (docker-compose.ssh.yml
 * — Teleport is the real product, not a simulator). We provision a Teleport user +
 * role through `tctl`, sign a short-lived identity file, then connect with `tsh` and
 * assert the session lands on the enrolled workspace node as the principal our pure
 * `workspacePrincipal` derives. A login the role doesn't grant is denied.
 *
 * Phase 4 additions (all on the same real Teleport cluster):
 *  - S3 session recording: after the SSH session a recording object appears in
 *    the S3 bucket on the sockerless-aws-ssh sim (port 4567 on the host).
 *  - GitHub connector: `tctl create` accepts a GitHub connector pointing at
 *    bleephub-ssh; `tctl get github` confirms it is stored.
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

// S3 sim (sockerless-aws-ssh) exposed at port 4567 on the host.
// Teleport writes session recordings to the `edd-e2e-sessions` bucket.
const S3_SIM_PORT = 4567;
const RECORDING_BUCKET = "edd-e2e-sessions";

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

/** List objects in an S3 bucket via the sockerless-aws-ssh sim's REST API. */
function listS3Objects(bucket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: S3_SIM_PORT,
        path: `/${bucket}?list-type=2`,
        method: "GET",
        headers: { Host: `${bucket}.s3.amazonaws.com` },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () => {
          resolve(body);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  it("stores the SSH session recording in S3 (endpoint-only, sockerless-aws-ssh sim)", async () => {
    // A recording object appears in the bucket shortly after the session above.
    // Poll with generous timeout: Teleport buffers recordings and uploads them
    // asynchronously (may take a few seconds after session end).
    const deadline = Date.now() + 30_000;
    let found = false;
    while (Date.now() < deadline) {
      try {
        const body = await listS3Objects(RECORDING_BUCKET);
        // An object key is present when Teleport has uploaded at least one recording.
        if (body.includes("<Key>")) {
          found = true;
          break;
        }
      } catch {
        // S3 bucket may not exist yet if no recording uploaded; retry.
      }
      await sleep(2_000);
    }
    expect(found, "no session recording found in S3 within 30s").toBe(true);
  });

  it("accepts a Teleport GitHub connector pointing at bleephub-ssh (federation config)", () => {
    // Create a GitHub connector referencing bleephub-ssh. `endpoint_url` is
    // Teleport's GHES feature that redirects all GitHub API calls to a custom host
    // (the same mechanism production uses against github.enterprise.example.com).
    // This proves the connector config is accepted — the full browser-based OAuth
    // login flow is deferred to e2e-aws / Playwright browser testing.
    const connectorYaml = [
      "kind: github",
      "version: v3",
      "metadata:",
      "  name: github-e2e",
      "spec:",
      "  client_id: edd",
      "  client_secret: secret",
      // redirect_url must use the proxy's web address
      `  redirect_url: https://${PROXY_WEB_ADDR}/v1/webapi/github/callback`,
      // endpoint_url points at bleephub-ssh inside the Docker network (port 5555
      // is the container-internal port; BLEEPHUB_SSH_PORT=5556 is the host port).
      // This is the GHES endpoint override (Teleport 17+, §6.8 endpoint-only).
      "  endpoint_url: http://bleephub-ssh:5555",
      "  teams_to_roles:",
      "    - organization: acme",
      "      team: platform-admins",
      "      roles:",
      `        - ${TELEPORT_ROLE}`,
      "",
    ].join("\n");

    const created = tctl(["create", "-f", "-"], connectorYaml);
    if (created.status !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      throw new Error(`GitHub connector create failed:\n${created.stdout}${created.stderr}`);
    }

    const listed = tctl(["get", "github"]);
    expect(listed.status, `tctl get github: ${listed.stderr}`).toBe(0);
    expect(listed.stdout).toMatch(/github-e2e/);
  });
});
