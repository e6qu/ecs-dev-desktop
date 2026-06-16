// SPDX-License-Identifier: AGPL-3.0-or-later
import { fingerprintPublicKey } from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeSshKeyEntity } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshKeyConflictError, SshKeyService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-ssh-keys-itest";

// Real ed25519 public keys (inert fixtures — never compared against the clock).
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4ZbjzMeOtIzbUqhfKMeKGhK/v/L86UOuNmnczpU42p alice@laptop";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZBANeXuKzUz8czqLXOC2dgKD/Ia+l8/lZQbpgQ8Vh9 bob@desktop";

// A monotonic clock so list-ordering by createdAt is deterministic.
function tickingClock(): { now(): string } {
  let n = 0;
  return { now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, n++)).toISOString() };
}

describe("SshKeyService against DynamoDB Local", () => {
  let svc: SshKeyService;

  beforeAll(async () => {
    const dynamo = createDynamoClient();
    await dropTable(dynamo, TABLE);
    await ensureTable(dynamo, TABLE);
    svc = new SshKeyService({ keys: makeSshKeyEntity(dynamo, TABLE), clock: tickingClock() });
  });

  afterAll(async () => {
    await dropTable(createDynamoClient(), TABLE);
  });

  it("registers a key, derives its fingerprint + type, and defaults the label to the comment", async () => {
    const dto = await svc.register("alice", KEY_A);
    expect(dto.fingerprint).toBe(fingerprintPublicKey(KEY_A));
    expect(dto.keyType).toBe("ssh-ed25519");
    expect(dto.label).toBe("alice@laptop");
    expect(dto.id).toMatch(/^sshk-/);
  });

  it("honors an explicit label", async () => {
    const dto = await svc.register("alice", KEY_B, "  work key  ");
    expect(dto.label).toBe("work key");
  });

  it("lists the caller's keys newest-first", async () => {
    const keys = await svc.list("alice");
    expect(keys.map((k) => k.label)).toEqual(["work key", "alice@laptop"]);
  });

  it("rejects re-registering the same key for the same owner (idempotency)", async () => {
    await expect(svc.register("alice", KEY_A)).rejects.toBeInstanceOf(SshKeyConflictError);
    await expect(svc.register("alice", KEY_A)).rejects.toMatchObject({ ownedByCaller: true });
  });

  it("rejects registering a key already owned by another account (global uniqueness)", async () => {
    await expect(svc.register("mallory", KEY_A)).rejects.toMatchObject({ ownedByCaller: false });
  });

  it("resolves a presented public key to its owner (gateway lookup)", async () => {
    const match = await svc.ownerForKey(KEY_A);
    expect(match?.ownerId).toBe("alice");
    expect(await svc.ownerForKey(KEY_B)).toMatchObject({ ownerId: "alice" });
  });

  it("returns null for an unregistered key", async () => {
    const unknown =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE3Qm0m5l5p5h7Vd2yq0a8t8m8m8m8m8m8m8m8m8m8m nobody@x";
    expect(await svc.ownerForKey(unknown)).toBeNull();
  });

  it("deletes only the caller's own key", async () => {
    const [first] = await svc.list("alice");
    if (first === undefined) throw new Error("expected at least one key");
    // Another user cannot delete it (ownership-scoped).
    expect(await svc.remove("mallory", first.id)).toBe(false);
    expect(await svc.remove("alice", first.id)).toBe(true);
    expect((await svc.list("alice")).some((k) => k.id === first.id)).toBe(false);
    // Its fingerprint is now free to register again.
    const freed = await svc.register("carol", first.publicKey);
    expect(freed.fingerprint).toBe(first.fingerprint);
  });
});
