// SPDX-License-Identifier: AGPL-3.0-or-later
import { isoTimestamp } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeControlPlaneActivityEntity,
} from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ControlPlaneActivityService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const TABLE = "ecs-dev-desktop-cp-activity-itest";

describe("ControlPlaneActivityService (real DynamoDB)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let svc: ControlPlaneActivityService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TABLE);
    await ensureTable(client, TABLE);
    svc = new ControlPlaneActivityService({
      activity: makeControlPlaneActivityEntity(client, TABLE),
    });
  });

  afterAll(async () => {
    await dropTable(createDynamoClient(), TABLE);
  });

  it("returns undefined before any activity is recorded", async () => {
    expect(await svc.readLastActivity()).toBeUndefined();
  });

  it("records the last-activity instant and reads it back", async () => {
    const t = isoTimestamp("2026-07-11T12:00:00.000Z");
    await svc.recordActivity(t);
    expect(await svc.readLastActivity()).toBe(t);
  });

  it("upserts idempotently — the latest write wins the single row", async () => {
    const t1 = isoTimestamp("2026-07-11T12:01:00.000Z");
    const t2 = isoTimestamp("2026-07-11T12:02:00.000Z");
    await svc.recordActivity(t1);
    await svc.recordActivity(t2);
    expect(await svc.readLastActivity()).toBe(t2);
  });
});
