// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";

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

// bleephub-ssh is exposed on port 5556 on the host (container-internal: 5555).
// Used for Phase 4 GitHub OAuth login via Teleport's GHES endpoint-override.
const BLEEPHUB_OAUTH_PORT = 5556;
// bleephub's hardcoded default admin token (store.go:580) — not a real GitHub credential.
// Suppressed in .trivyignore.yaml (e6qu/sockerless#501 tracks making this configurable).
const BLEEPHUB_ADMIN_TOKEN = "ghp_0000000000000000000000000000000000000000";
const TELEPORT_WEB_PORT = 3080;
const GITHUB_CONNECTOR = "github-e2e";

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

interface HopResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Single HTTP request to bleephub at 127.0.0.1:BLEEPHUB_OAUTH_PORT. */
function bleephubReq(method: string, path: string, body?: unknown): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const extraHeaders: Record<string, string | number> = {};
    if (bodyStr) {
      extraHeaders["Content-Type"] = "application/json";
      extraHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: BLEEPHUB_OAUTH_PORT,
        path,
        method,
        headers: { Authorization: `token ${BLEEPHUB_ADMIN_TOKEN}`, ...extraHeaders },
      },
      (res: IncomingMessage) => {
        let b = "";
        res.on("data", (c: Buffer) => {
          b += c.toString();
        });
        res.on("end", () => {
          const h: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = v;
          resolve({ status: res.statusCode ?? 0, headers: h, body: b });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Single HTTPS request to Teleport (self-signed cert — rejectUnauthorized: false). */
function teleportReq(url: URL, cookieJar: Map<string, string>): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const cookies = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = httpsRequest(
      {
        host: "localhost",
        port: TELEPORT_WEB_PORT,
        path: url.pathname + url.search,
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          Host: `localhost:${TELEPORT_WEB_PORT}`,
          ...(cookies ? { Cookie: cookies } : {}),
        },
      },
      (res: IncomingMessage) => {
        let b = "";
        res.on("data", (c: Buffer) => {
          b += c.toString();
        });
        res.on("end", () => {
          const h: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = v;
          resolve({ status: res.statusCode ?? 0, headers: h, body: b });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Single HTTP request to bleephub's OAuth authorize endpoint (redirect follower hop). */
function bleephubOAuthReq(url: URL, cookieJar: Map<string, string>): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const cookies = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: BLEEPHUB_OAUTH_PORT,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Host: url.hostname,
          ...(cookies ? { Cookie: cookies } : {}),
        },
      },
      (res: IncomingMessage) => {
        let b = "";
        res.on("data", (c: Buffer) => {
          b += c.toString();
        });
        res.on("end", () => {
          const h: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = v;
          resolve({ status: res.statusCode ?? 0, headers: h, body: b });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function parseCookies(setCookie: string | string[] | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!setCookie) return jar;
  for (const sc of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const part = sc.split(";")[0] ?? "";
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

/**
 * Follow the Teleport → bleephub-ssh → Teleport callback redirect chain headlessly.
 *
 * Teleport redirects to `http://bleephub-ssh:5555/login/oauth/authorize?...` (Docker
 * service name, not reachable from host). We rewrite that to `127.0.0.1:5556` and
 * append `&auto=1` — bleephub's non-interactive shortcut that skips the consent form
 * and uses the seed admin user (same pattern as azure-sim's immediate code issuance).
 * All server-to-server calls (Teleport → bleephub token exchange / user info / teams)
 * happen inside Docker and are unaffected by this host-side URL rewriting.
 *
 * Returns after processing the Teleport GitHub callback (status < 400 = success).
 */
async function driveGitHubOAuthFlow(): Promise<HopResult> {
  const cookieJar = new Map<string, string>();
  let current = new URL(
    `https://localhost:${TELEPORT_WEB_PORT.toString()}/v1/webapi/github/login/web?connector_id=${GITHUB_CONNECTOR}`,
  );
  let lastResult: HopResult | undefined;

  for (let i = 0; i < 10; i++) {
    const isBleephubHost = current.hostname === "bleephub-ssh" || current.hostname === "127.0.0.1";
    const isBleephubPort = current.port === "5555" || current.port === String(BLEEPHUB_OAUTH_PORT);
    const isBleephub = isBleephubHost && isBleephubPort;

    const result = await (isBleephub ? bleephubOAuthReq : teleportReq)(current, cookieJar);
    lastResult = result;

    for (const [k, v] of parseCookies(result.headers["set-cookie"])) cookieJar.set(k, v);

    // Stop after the Teleport GitHub callback — Teleport processes the code here
    // and creates the user session. The subsequent redirect is to the web dashboard.
    if (current.pathname.startsWith("/v1/webapi/github/callback")) break;

    if (result.status < 300 || result.status >= 400) break;

    const location = result.headers.location;
    const rawLoc = Array.isArray(location) ? location[0] : location;
    if (!rawLoc) break;

    const next = new URL(rawLoc, `https://localhost:${TELEPORT_WEB_PORT.toString()}`);

    // Rewrite bleephub Docker service name to the host-exposed port.
    if (next.hostname === "bleephub-ssh" || next.port === "5555") {
      next.hostname = "127.0.0.1";
      next.port = String(BLEEPHUB_OAUTH_PORT);
      // Non-interactive shortcut: skip the consent form, use seed admin user.
      next.searchParams.set("auto", "1");
    }

    current = next;
  }

  if (!lastResult) throw new Error("driveGitHubOAuthFlow: no response");
  return lastResult;
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
    // -t requests a PTY from the server so this session is interactive. Teleport
    // only writes recording files for PTY sessions; the S3 recording test below
    // polls for the file that this session produces.
    const res = tsh("ssh", "--no-use-local-ssh-agent", "-t", `${PRINCIPAL}@${NODE_NAME}`, "whoami");
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
    // NOTE: must run before the GitHub OAuth login test (below) — the connector
    // must exist in Teleport for driveGitHubOAuthFlow() to find it.
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

  it("logs in to Teleport via GitHub OAuth (bleephub-ssh, full OIDC redirect chain)", async () => {
    // Seed bleephub: create the acme org, platform-admins team, and add the seed
    // admin user (login: "admin") as a member — Teleport maps this team to edd-ssh-e2e.
    // All three calls are idempotent: 422 means the resource already exists.
    const orgRes = await bleephubReq("POST", "/api/v3/admin/organizations", {
      login: "acme",
      admin: "admin",
      profile_name: "Acme Corp",
    });
    if (orgRes.status !== 201 && orgRes.status !== 422) {
      throw new Error(`bleephub org create: ${orgRes.status.toString()} ${orgRes.body}`);
    }
    const teamRes = await bleephubReq("POST", "/api/v3/orgs/acme/teams", {
      name: "platform-admins",
      privacy: "closed",
    });
    if (teamRes.status !== 201 && teamRes.status !== 422) {
      throw new Error(`bleephub team create: ${teamRes.status.toString()} ${teamRes.body}`);
    }
    const memberRes = await bleephubReq(
      "PUT",
      "/api/v3/orgs/acme/teams/platform-admins/memberships/admin",
      { role: "member" },
    );
    if (memberRes.status !== 200 && memberRes.status !== 201) {
      throw new Error(`bleephub team membership: ${memberRes.status.toString()} ${memberRes.body}`);
    }

    // Drive the full OAuth redirect chain:
    //   Teleport /v1/webapi/github/login/web
    //   → bleephub-ssh /login/oauth/authorize?auto=1 (skips consent form)
    //   → Teleport /v1/webapi/github/callback
    // Teleport's server-to-server calls (token exchange, /api/v3/user, /api/v3/user/teams)
    // all happen inside Docker using the bleephub-ssh service name.
    const callbackResult = await driveGitHubOAuthFlow();
    expect(
      callbackResult.status,
      `GitHub OAuth callback failed (${callbackResult.status.toString()}): ${callbackResult.body.slice(0, 200)}`,
    ).toBeLessThan(500);

    // Teleport creates/updates a user named after the GitHub login ("admin") and assigns
    // the roles mapped from the team. Verify both facts.
    const userGet = tctl(["get", `user/admin`]);
    expect(userGet.status, `tctl get user/admin: ${userGet.stderr}`).toBe(0);
    expect(userGet.stdout, "expected edd-ssh-e2e role mapped from acme/platform-admins").toMatch(
      TELEPORT_ROLE,
    );
  });
});
