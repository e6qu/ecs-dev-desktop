// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";
import type { AuditEvent } from "./audit";
import { auditToLogLines } from "./logs";

const event: AuditEvent = {
  at: isoTimestamp("2026-06-04T01:00:00.000Z"),
  actor: "system",
  action: "workspace.created",
  target: "ws-a",
  detail: "workspace provisioned",
};

describe("auditToLogLines", () => {
  it("projects each audit event to an info-level control-plane log line", () => {
    const [line] = auditToLogLines([event]);
    expect(line?.level).toBe("info");
    expect(line?.source).toBe("ws-a");
    expect(line?.at).toBe(event.at);
    expect(line?.message).toContain("workspace.created");
    expect(line?.message).toContain("system");
    expect(line?.message).toContain("workspace provisioned");
  });

  it("preserves order and count", () => {
    expect(auditToLogLines([event, event, event])).toHaveLength(3);
  });
});
