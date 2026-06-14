// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";
import { reconcilerHealthFromHeartbeat, summarizeHealth, type ComponentHealth } from "./health";

const AT = isoTimestamp("2026-06-04T00:00:00.000Z");
const c = (status: ComponentHealth["status"]): ComponentHealth => ({ component: status, status });

describe("summarizeHealth", () => {
  it("is ok when all components are ok", () => {
    expect(summarizeHealth([c("ok"), c("ok")], AT).status).toBe("ok");
  });

  it("treats unknown as ok for the overall roll-up", () => {
    expect(summarizeHealth([c("ok"), c("unknown")], AT).status).toBe("ok");
  });

  it("rolls up to degraded, and down dominates", () => {
    expect(summarizeHealth([c("ok"), c("degraded")], AT).status).toBe("degraded");
    expect(summarizeHealth([c("degraded"), c("down")], AT).status).toBe("down");
  });

  it("carries components and timestamp through", () => {
    const r = summarizeHealth([c("ok")], AT);
    expect(r.components).toHaveLength(1);
    expect(r.checkedAt).toBe(AT);
  });
});

describe("reconcilerHealthFromHeartbeat", () => {
  const now = isoTimestamp("2026-06-04T00:30:00.000Z");

  it("is unknown when no sweep has been recorded", () => {
    expect(reconcilerHealthFromHeartbeat(undefined, now).status).toBe("unknown");
  });

  it("is ok when the last sweep is within the staleness window", () => {
    const recent = isoTimestamp("2026-06-04T00:20:00.000Z"); // 10 min ago < 15 min
    expect(reconcilerHealthFromHeartbeat(recent, now).status).toBe("ok");
  });

  it("is degraded when the last sweep is older than the staleness window", () => {
    const old = isoTimestamp("2026-06-04T00:00:00.000Z"); // 30 min ago > 15 min
    const h = reconcilerHealthFromHeartbeat(old, now);
    expect(h.status).toBe("degraded");
    expect(h.component).toBe("reconciler");
  });
});
