// SPDX-License-Identifier: AGPL-3.0-or-later
import { listSshKeysResponse, registerSshKeyResponse } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import {
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../lib/test-support/workspace-route-harness";
import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-ssh-keys-integ");

const base = "http://localhost/api/ssh-keys";
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4ZbjzMeOtIzbUqhfKMeKGhK/v/L86UOuNmnczpU42p alice@laptop";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDXm9BOT8EBmUFLyp//axmOC3Cpg7Y8M/vYegl0+PIbx bob@desktop";
const KEY_C =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPrRbd6nXbeqi/zZlhYnFlq00cvMhe9UHQLxhdThG3fq dave@x";

function register(actor: string, publicKey: string, label?: string): Promise<Response> {
  return POST(
    new Request(base, {
      method: "POST",
      headers: member(actor),
      body: JSON.stringify({ publicKey, ...(label !== undefined ? { label } : {}) }),
    }),
  );
}

const list = (actor: string): Promise<Response> =>
  GET(new Request(base, { headers: member(actor) }));

const remove = (actor: string, id: string): Promise<Response> =>
  DELETE(new Request(`${base}/${id}`, { method: "DELETE", headers: member(actor) }), routeCtx(id));

describe("/api/ssh-keys (DynamoDB Local)", () => {
  it("rejects an unauthenticated caller (401)", async () => {
    const res = await GET(new Request(base));
    expect(res.status).toBe(401);
  });

  it("registers a key (201) and lists it back", async () => {
    const res = await register("alice", KEY_A, "laptop");
    expect(res.status).toBe(201);
    const { key } = registerSshKeyResponse.parse(await res.json());
    expect(key.label).toBe("laptop");
    expect(key.keyType).toBe("ssh-ed25519");
    expect(key.fingerprint).toMatch(/^SHA256:/);

    const listed = listSshKeysResponse.parse(await (await list("alice")).json());
    expect(listed.keys.map((k) => k.id)).toContain(key.id);
  });

  it("rejects a malformed public key (400)", async () => {
    expect((await register("alice", "not-a-key")).status).toBe(400);
  });

  it("rejects re-registering the same key (409)", async () => {
    expect((await register("alice", KEY_A)).status).toBe(409);
  });

  it("rejects a key already owned by another account (409, global uniqueness)", async () => {
    expect((await register("mallory", KEY_A)).status).toBe(409);
  });

  it("scopes the list to the caller", async () => {
    expect((await register("bob", KEY_B)).status).toBe(201);
    const bobKeys = listSshKeysResponse.parse(await (await list("bob")).json());
    expect(bobKeys.keys.every((k) => k.publicKey === KEY_B)).toBe(true);
    const aliceKeys = listSshKeysResponse.parse(await (await list("alice")).json());
    expect(aliceKeys.keys.some((k) => k.publicKey === KEY_B)).toBe(false);
  });

  it("deletes only the caller's own key (404 for another user's)", async () => {
    const key = registerSshKeyResponse.parse(await (await register("dave", KEY_C)).json()).key;
    expect((await remove("alice", key.id)).status).toBe(404);
    expect((await remove("dave", key.id)).status).toBe(200);
    const after = listSshKeysResponse.parse(await (await list("dave")).json());
    expect(after.keys.some((k) => k.id === key.id)).toBe(false);
  });
});
