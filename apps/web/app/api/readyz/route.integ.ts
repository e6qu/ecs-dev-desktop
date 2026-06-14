// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDynamoClient, dropTable, dynamodb, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET } from "./route";

const readyzBody = z.object({
  status: z.string(),
  checks: z.array(z.object({ component: z.string(), status: z.string() })),
});

const TEST_TABLE = "ecs-dev-desktop-readyz-integ";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

describe("GET /api/readyz (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(() => {
    client = createDynamoClient();
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("is 200 ready when the single table is ACTIVE", async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = readyzBody.parse(await res.json());
    expect(body.status).toBe("ready");
    expect(body.checks[0]).toMatchObject({ component: "dynamodb", status: "ok" });
  });

  it("is 503 unready when the table is missing (data store unreachable)", async () => {
    await dropTable(client, TEST_TABLE);

    const res = await GET();
    expect(res.status).toBe(503);
    expect(readyzBody.parse(await res.json()).status).toBe("unready");
  });
});
