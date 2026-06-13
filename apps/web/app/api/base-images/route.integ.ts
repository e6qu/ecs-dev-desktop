// SPDX-License-Identifier: AGPL-3.0-or-later
import { baseImageEntry, listBaseImagesResponse } from "@edd/api-contracts";
import { createDynamoClient, dropTable, dynamodb, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { DELETE, GET as GET_ONE, PATCH } from "./[id]/route";
import { GET, POST } from "./route";

const TEST_TABLE = "ecs-dev-desktop-baseimg-integ";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

const url = "http://localhost/api/base-images";
const admin = {
  [USER_ID_HEADER]: "root",
  [ROLE_HEADER]: "admin",
  "content-type": "application/json",
};
const member = {
  [USER_ID_HEADER]: "al",
  [ROLE_HEADER]: "member",
  "content-type": "application/json",
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("base-images API end-to-end (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("admins manage the catalog; members can read but not write", async () => {
    const body = JSON.stringify({ name: "Node 20", image: "golden/node:20", description: "LTS" });

    // A member cannot create.
    const denied = await POST(new Request(url, { method: "POST", headers: member, body }));
    expect(denied.status).toBe(403);

    // An admin creates.
    const createRes = await POST(new Request(url, { method: "POST", headers: admin, body }));
    expect(createRes.status).toBe(201);
    const entry = baseImageEntry.parse(await createRes.json());
    expect(entry).toMatchObject({ name: "Node 20", enabled: true });

    // A member can browse the catalog.
    const listRes = await GET(new Request(url, { headers: member }));
    expect(listRes.status).toBe(200);
    const list = listBaseImagesResponse.parse(await listRes.json());
    expect(list.baseImages.map((e) => e.id)).toContain(entry.id);

    const one = `${url}/${entry.id}`;

    // An admin disables it.
    const patched = await PATCH(
      new Request(one, {
        method: "PATCH",
        headers: admin,
        body: JSON.stringify({ enabled: false }),
      }),
      ctx(entry.id),
    );
    expect(patched.status).toBe(200);
    expect(baseImageEntry.parse(await patched.json()).enabled).toBe(false);

    // A member cannot delete.
    const delDenied = await DELETE(
      new Request(one, { method: "DELETE", headers: member }),
      ctx(entry.id),
    );
    expect(delDenied.status).toBe(403);

    // An admin deletes; then it 404s.
    const del = await DELETE(new Request(one, { method: "DELETE", headers: admin }), ctx(entry.id));
    expect(del.status).toBe(204);
    const gone = await GET_ONE(new Request(one, { headers: admin }), ctx(entry.id));
    expect(gone.status).toBe(404);
  });

  it("returns 404 (not 409) when updating or deleting a missing catalog entry", async () => {
    const one = `${url}/img-does-not-exist`;
    // A missing entry (not_found domain error) must map to 404, not 409.
    const patch = await PATCH(
      new Request(one, {
        method: "PATCH",
        headers: admin,
        body: JSON.stringify({ enabled: false }),
      }),
      ctx("img-does-not-exist"),
    );
    expect(patch.status).toBe(404);

    const del = await DELETE(
      new Request(one, { method: "DELETE", headers: admin }),
      ctx("img-does-not-exist"),
    );
    expect(del.status).toBe(404);
  });

  it("rejects an empty PATCH body with 400 (the contract requires a field)", async () => {
    const created = await POST(
      new Request(url, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Go", image: "golden/go:1.22" }),
      }),
    );
    const entry = baseImageEntry.parse(await created.json());
    const res = await PATCH(
      new Request(`${url}/${entry.id}`, { method: "PATCH", headers: admin, body: "{}" }),
      ctx(entry.id),
    );
    expect(res.status).toBe(400);
  });
});
