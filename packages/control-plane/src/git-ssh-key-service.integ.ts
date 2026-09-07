// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintPublicKey, ownerId, sshKeyId } from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeGitSshKeyEntity } from "@edd/db";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitSshKeyService } from "./index";

process.env.AWS_ENDPOINT_URL ??= dynamodb.endpoint;
const TABLE = "ecs-dev-desktop-git-ssh-keys-itest";

function tickingClock(): { now(): string } {
  let n = 0;
  return { now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, n++)).toISOString() };
}

/** What OpenSSH itself derives from the private key file — the proof the generated
 * material is a real `IdentityFile`, not merely something ssh2 round-trips. */
function publicKeyAccordingToOpenSsh(privateKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edd-git-ssh-key-"));
  try {
    const file = join(dir, "id");
    writeFileSync(file, privateKey, { mode: 0o600 });
    return execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("GitSshKeyService", () => {
  let svc: GitSshKeyService;
  const alice = ownerId("alice");
  const bob = ownerId("bob");

  beforeAll(async () => {
    const dynamo = createDynamoClient();
    await dropTable(dynamo, TABLE);
    await ensureTable(dynamo, TABLE);
    svc = new GitSshKeyService({
      keys: makeGitSshKeyEntity(dynamo, TABLE),
      encryptionKeyHex: randomBytes(32).toString("hex"),
      generateKeyPair: (comment) => {
        const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment });
        return { publicKey: pair.public, privateKey: pair.private };
      },
      clock: tickingClock(),
    });
  });

  afterAll(async () => {
    await dropTable(createDynamoClient(), TABLE);
  });

  it("generates an ed25519 key whose public half is what OpenSSH derives from the private half", async () => {
    const key = await svc.generate(alice, "laptop");
    expect(key.keyType).toBe("ssh-ed25519");
    expect(key.label).toBe("laptop");
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAA[0-9A-Za-z+/=]+ edd:alice:laptop$/);
    expect(key.fingerprint).toBe(fingerprintPublicKey(key.publicKey));

    const [material] = await svc.materials(alice);
    expect(material?.id).toBe(key.id);
    expect(material?.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(publicKeyAccordingToOpenSsh(material?.privateKey ?? "")).toBe(key.publicKey);
  });

  it("stores the private half only as ciphertext", async () => {
    const dynamo = createDynamoClient();
    const entity = makeGitSshKeyEntity(dynamo, TABLE);
    const { data } = await entity.query.primary({ ownerId: alice }).go({ pages: "all" });
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row.privateKeyCiphertext).not.toContain("OPENSSH PRIVATE KEY");
      expect(Object.keys(row)).not.toContain("privateKey");
    }
  });

  it("lists an owner's keys newest first and never another owner's", async () => {
    await svc.generate(alice, "desktop");
    await svc.generate(bob, "bob-key");
    const keys = await svc.list(alice);
    expect(keys.map((k) => k.label)).toEqual(["desktop", "laptop"]);
    expect((await svc.list(bob)).map((k) => k.label)).toEqual(["bob-key"]);
    // The public listing never carries private material.
    for (const key of keys) expect(Object.keys(key)).not.toContain("privateKey");
  });

  it("deletes only the owner's own key", async () => {
    const [bobsKey] = await svc.list(bob);
    expect(bobsKey).toBeDefined();
    expect(await svc.remove(alice, sshKeyId(bobsKey?.id ?? ""))).toBe(false);
    expect((await svc.list(bob)).length).toBe(1);
    expect(await svc.remove(bob, sshKeyId(bobsKey?.id ?? ""))).toBe(true);
    expect(await svc.list(bob)).toEqual([]);
  });

  it("refuses a blank label", async () => {
    await expect(svc.generate(alice, "   ")).rejects.toThrow("needs a label");
  });
});
