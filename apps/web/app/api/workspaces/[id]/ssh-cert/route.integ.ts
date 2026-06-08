// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sshCertResponse } from "@edd/api-contracts";

import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { POST } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-ssh-cert-integ");

let caDir: string;
let userDir: string;
let userPubKey: string;

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), "edd-integ-ca-"));
  const caKey = join(caDir, "ca");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", caKey, "-C", "integ-ca"]);
  process.env.EDD_SSH_CA_KEY_PATH = caKey;

  userDir = mkdtempSync(join(tmpdir(), "edd-integ-user-"));
  const userKey = join(userDir, "id");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", userKey, "-C", "integ-user"]);
  userPubKey = readFileSync(`${userKey}.pub`, "utf8").trim();
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  delete process.env.EDD_SSH_CA_KEY_PATH;
});

function postCert(actor: string, id: string, publicKey: string): Promise<Response> {
  return POST(
    new Request(`${apiBase}/${id}/ssh-cert`, {
      method: "POST",
      headers: member(actor),
      body: JSON.stringify({ publicKey }),
    }),
    routeCtx(id),
  );
}

describe("POST /api/workspaces/:id/ssh-cert (DynamoDB Local)", () => {
  it("returns a signed cert for an owned workspace (200)", async () => {
    const id = await createWorkspaceFor("alice");
    const res = await postCert("alice", id, userPubKey);
    expect(res.status).toBe(200);
    const body = sshCertResponse.parse(await res.json());
    expect(body.cert).toMatch(/^ssh-ed25519-cert-v01@openssh\.com /);
  });

  it("returns 400 for an empty public key", async () => {
    const id = await createWorkspaceFor("alice");
    const res = await postCert("alice", id, "");
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent workspace", async () => {
    const res = await postCert("alice", "does-not-exist", userPubKey);
    expect(res.status).toBe(404);
  });

  it("returns 403 for a different member's workspace", async () => {
    const id = await createWorkspaceFor("alice");
    const res = await postCert("bob", id, userPubKey);
    expect(res.status).toBe(403);
  });
});
