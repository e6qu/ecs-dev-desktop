// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetStatus } from "./fleet-status";

const { getFleetStatusMock } = vi.hoisted(() => ({ getFleetStatusMock: vi.fn() }));
vi.mock("./fleet-status", () => ({ getFleetStatus: getFleetStatusMock }));

import { getQuotaReport } from "./quota-report";

// Default caps: viewer 0, developer 5, admin unlimited (@edd/config DEFAULT_WORKSPACE_QUOTAS).
const fleet = (usage: FleetStatus["usage"]): FleetStatus => ({
  stats: { total: 0, byState: {}, active: 0 } as unknown as FleetStatus["stats"],
  owners: usage.length,
  usage,
});

describe("getQuotaReport — over-limit flagging", () => {
  afterEach(() => getFleetStatusMock.mockReset());

  it("flags a developer at/over their cap (5) and not below; carries role + limit", async () => {
    getFleetStatusMock.mockResolvedValue(
      fleet([
        { owner: "u-at", count: 5, role: "developer" },
        { owner: "u-under", count: 3, role: "developer" },
      ]),
    );
    const { usage } = await getQuotaReport();
    expect(usage.find((u) => u.owner === "u-at")).toMatchObject({
      role: "developer",
      limit: 5,
      atOrOver: true,
    });
    expect(usage.find((u) => u.owner === "u-under")).toMatchObject({ limit: 5, atOrOver: false });
  });

  it("NEVER flags an admin (unlimited), and reports their limit as null", async () => {
    getFleetStatusMock.mockResolvedValue(fleet([{ owner: "u-admin", count: 99, role: "admin" }]));
    const { usage } = await getQuotaReport();
    expect(usage[0]).toMatchObject({ role: "admin", limit: null, atOrOver: false });
  });

  it("flags a viewer (cap 0) with any workspace", async () => {
    getFleetStatusMock.mockResolvedValue(fleet([{ owner: "u-viewer", count: 1, role: "viewer" }]));
    const { usage } = await getQuotaReport();
    expect(usage[0]).toMatchObject({ role: "viewer", limit: 0, atOrOver: true });
  });

  it("unknown-role rows flag against the strictest POSITIVE cap (5), not the 0 viewer cap", async () => {
    getFleetStatusMock.mockResolvedValue(
      fleet([
        { owner: "u-legacy-over", count: 5 },
        { owner: "u-legacy-under", count: 4 },
      ]),
    );
    const { usage } = await getQuotaReport();
    // No role known → limit stays null, but the flag uses the strictest positive cap (developer=5).
    expect(usage.find((u) => u.owner === "u-legacy-over")).toMatchObject({
      limit: null,
      atOrOver: true,
    });
    expect(usage.find((u) => u.owner === "u-legacy-under")).toMatchObject({
      limit: null,
      atOrOver: false,
    });
    expect(usage.every((u) => u.role === undefined)).toBe(true);
  });
});
