// SPDX-License-Identifier: AGPL-3.0-or-later
import { fingerprintPublicKey, ownerId, sshKeyId, sshPublicKey } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeSshKeyEntity,
  makeSshKeyFingerprintEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshKeyConflictError, SshKeyService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-ssh-keys-itest";

// Real ed25519 public keys (inert fixtures — never compared against the clock).
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4ZbjzMeOtIzbUqhfKMeKGhK/v/L86UOuNmnczpU42p alice@laptop";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZBANeXuKzUz8czqLXOC2dgKD/Ia+l8/lZQbpgQ8Vh9 bob@desktop";
const KEY_C =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKA1+rpLqH5A/dIfoBrc4KoHz8LmkDeeoHNiUvA1B5MA carol@concurrent";

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
    svc = new SshKeyService({
      keys: makeSshKeyEntity(dynamo, TABLE),
      fingerprints: makeSshKeyFingerprintEntity(dynamo, TABLE),
      clock: tickingClock(),
    });
  });

  afterAll(async () => {
    await dropTable(createDynamoClient(), TABLE);
  });

  it("registers a key, derives its fingerprint + type, and defaults the label to the comment", async () => {
    const dto = await svc.register(ownerId("alice"), sshPublicKey(KEY_A));
    expect(dto.fingerprint).toBe(fingerprintPublicKey(KEY_A));
    expect(dto.keyType).toBe("ssh-ed25519");
    expect(dto.label).toBe("alice@laptop");
    expect(dto.id).toMatch(/^sshk-/);
  });

  it("honors an explicit label", async () => {
    const dto = await svc.register(ownerId("alice"), sshPublicKey(KEY_B), "  work key  ");
    expect(dto.label).toBe("work key");
  });

  it("lists the caller's keys newest-first", async () => {
    const keys = await svc.list(ownerId("alice"));
    expect(keys.map((k) => k.label)).toEqual(["work key", "alice@laptop"]);
  });

  it("rejects re-registering the same key for the same owner (idempotency)", async () => {
    await expect(svc.register(ownerId("alice"), sshPublicKey(KEY_A))).rejects.toBeInstanceOf(SshKeyConflictError);
    await expect(svc.register(ownerId("alice"), sshPublicKey(KEY_A))).rejects.toMatchObject({ ownedByCaller: true });
  });

  it("rejects registering a key already owned by another account (global uniqueness)", async () => {
    await expect(svc.register(ownerId("mallory"), sshPublicKey(KEY_A))).rejects.toMatchObject({ ownedByCaller: false });
  });

  it("admits exactly one winner when two accounts register the same key concurrently", async () => {
    // The pre-fix read-then-put let both writers pass the GSI read and both commit;
    // the fingerprint-claim transaction makes exactly one win and the other conflict.
    const results = await Promise.allSettled([
      svc.register(ownerId("dana"), sshPublicKey(KEY_C)),
      svc.register(ownerId("erin"), sshPublicKey(KEY_C)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(SshKeyConflictError);
    }
    // Exactly one owner record exists for that fingerprint (no duplicate).
    const winner = await svc.ownerForKey(sshPublicKey(KEY_C));
    expect(winner).not.toBeNull();
    expect(["dana", "erin"]).toContain(winner?.ownerId);
  });

  it("resolves a presented public key to its owner (gateway lookup)", async () => {
    const match = await svc.ownerForKey(sshPublicKey(KEY_A));
    expect(match?.ownerId).toBe("alice");
    expect(await svc.ownerForKey(sshPublicKey(KEY_B))).toMatchObject({ ownerId: "alice" });
  });

  it("returns null for an unregistered key", async () => {
    const unknown =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE3Qm0m5l5p5h7Vd2yq0a8t8m8m8m8m8m8m8m8m8m8m nobody@x";
    expect(await svc.ownerForKey(sshPublicKey(unknown))).toBeNull();
  });

  it("deletes only the caller's own key", async () => {
    const [first] = await svc.list(ownerId("alice"));
    if (first === undefined) throw new Error("expected at least one key");
    // Another user cannot delete it (ownership-scoped).
    expect(await svc.remove(ownerId("mallory"), sshKeyId(first.id))).toBe(false);
    expect(await svc.remove(ownerId("alice"), sshKeyId(first.id))).toBe(true);
    expect((await svc.list(ownerId("alice"))).some((k) => k.id === first.id)).toBe(false);
    // Its fingerprint is now free to register again.
    const freed = await svc.register(ownerId("carol"), sshPublicKey(first.publicKey));
    expect(freed.fingerprint).toBe(first.fingerprint);
  });
});
