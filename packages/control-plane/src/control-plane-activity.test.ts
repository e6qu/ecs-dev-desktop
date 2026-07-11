// SPDX-License-Identifier: AGPL-3.0-or-later
import { isoTimestamp } from "@edd/core";
import type { ControlPlaneActivityEntity } from "@edd/db";
import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION,
  ControlPlaneActivityService,
} from "./control-plane-activity";

interface StoredRow {
  id: string;
  schemaVersion: number;
  lastActivityAt: string;
}

/**
 * A minimal in-memory stand-in for the ElectroDB `controlPlaneActivity` entity —
 * only the two methods the service calls (`put(...).go()`, `get(...).go()`). The
 * real shape is exercised by `control-plane-activity.integ.ts` against the sim's
 * DynamoDB; this fake makes the pure §6.5a schema-version gate deterministic.
 */
function fakeEntity(seed?: StoredRow): {
  entity: ControlPlaneActivityEntity;
  row: () => StoredRow | null;
} {
  let row: StoredRow | null = seed ?? null;
  const entity = {
    put(item: StoredRow) {
      return {
        go: () => {
          row = item;
          return Promise.resolve({ data: item });
        },
      };
    },
    get(_key: { id: string }) {
      return { go: () => Promise.resolve({ data: row }) };
    },
  } as unknown as ControlPlaneActivityEntity;
  return { entity, row: () => row };
}

describe("ControlPlaneActivityService", () => {
  it("returns undefined when no row exists yet", async () => {
    const { entity } = fakeEntity();
    const svc = new ControlPlaneActivityService({ activity: entity });
    expect(await svc.readLastActivity()).toBeUndefined();
  });

  it("records the current-version row and reads the instant back", async () => {
    const { entity, row } = fakeEntity();
    const svc = new ControlPlaneActivityService({ activity: entity });
    const t = isoTimestamp("2026-07-11T12:00:00.000Z");
    await svc.recordActivity(t);
    expect(row()).toEqual({
      id: "control-plane",
      schemaVersion: CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION,
      lastActivityAt: t,
    });
    expect(await svc.readLastActivity()).toBe(t);
  });

  it("discards a stale-schema-version blob rather than reading it (§6.5a)", async () => {
    const { entity } = fakeEntity({
      id: "control-plane",
      schemaVersion: CONTROL_PLANE_ACTIVITY_SCHEMA_VERSION + 1,
      lastActivityAt: "2026-07-11T12:00:00.000Z",
    });
    const svc = new ControlPlaneActivityService({ activity: entity });
    expect(await svc.readLastActivity()).toBeUndefined();
  });
});
