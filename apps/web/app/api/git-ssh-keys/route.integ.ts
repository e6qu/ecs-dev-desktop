// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import { generateGitSshKeyResponse, listGitSshKeysResponse } from "@edd/api-contracts";
import { createDynamoClient, dropTable, dynamodb, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

/**
 * The user-facing git SSH key routes against DynamoDB Local: generate returns the public
 * half only, list is owner-scoped, delete is owner-scoped, and everything answers 409 with
 * the reason when the deployment has no key store.
 */
const TEST_TABLE = "ecs-dev-desktop-git-ssh-keys-route-integ";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.AWS_ENDPOINT_URL ??= dynamodb.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

const url = "http://localhost/api/git-ssh-keys";
const as = (id: string): Record<string, string> => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: "developer",
  "content-type": "application/json",
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("git SSH key routes", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    process.env.EDD_TOKEN_ENC_KEY = randomBytes(32).toString("hex");
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    process.env.EDD_TOKEN_ENC_KEY = "";
    await dropTable(client, TEST_TABLE);
  });

  it("requires authentication", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
  });

  it("generates a key and returns only its public half; lists it for its owner only", async () => {
    const created = await POST(
      new Request(url, {
        method: "POST",
        headers: as("alice"),
        body: JSON.stringify({ label: "laptop" }),
      }),
    );
    expect(created.status).toBe(201);
    const { key } = generateGitSshKeyResponse.parse(await created.json());
    expect(key.label).toBe("laptop");
    expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(key)).not.toContain("PRIVATE KEY");

    const listed = listGitSshKeysResponse.parse(
      await (await GET(new Request(url, { headers: as("alice") }))).json(),
    );
    expect(listed.keys.map((k) => k.id)).toEqual([key.id]);
    const bobs = listGitSshKeysResponse.parse(
      await (await GET(new Request(url, { headers: as("bob") }))).json(),
    );
    expect(bobs.keys).toEqual([]);
  });

  it("rejects a blank label (400)", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: as("alice"),
        body: JSON.stringify({ label: "  " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("deletes only the caller's own key (404 for another user's)", async () => {
    const listed = listGitSshKeysResponse.parse(
      await (await GET(new Request(url, { headers: as("alice") }))).json(),
    );
    const id = listed.keys[0]?.id ?? "";
    expect(
      (await DELETE(new Request(`${url}/${id}`, { method: "DELETE", headers: as("bob") }), ctx(id)))
        .status,
    ).toBe(404);
    expect(
      (
        await DELETE(
          new Request(`${url}/${id}`, { method: "DELETE", headers: as("alice") }),
          ctx(id),
        )
      ).status,
    ).toBe(200);
    const after = listGitSshKeysResponse.parse(
      await (await GET(new Request(url, { headers: as("alice") }))).json(),
    );
    expect(after.keys).toEqual([]);
  });

  it("answers 409 with the reason when the deployment has no key store", async () => {
    const saved = process.env.EDD_TOKEN_ENC_KEY;
    process.env.EDD_TOKEN_ENC_KEY = "";
    try {
      const res = await GET(new Request(url, { headers: as("alice") }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("EDD_TOKEN_ENC_KEY");
    } finally {
      process.env.EDD_TOKEN_ENC_KEY = saved;
    }
  });
});
