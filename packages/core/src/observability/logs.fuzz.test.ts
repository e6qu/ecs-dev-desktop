// SPDX-License-Identifier: AGPL-3.0-or-later
// auditToLogLines projects untrusted audit fields (actor/detail/action) into the admin Logs view —
// the property is that it's total + order/length-preserving and never drops a field's content.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";
import type { AuditEvent } from "./audit";
import { auditToLogLines } from "./logs";

const eventArb: fc.Arbitrary<AuditEvent> = fc.record({
  at: fc.string().map((s) => isoTimestamp(s)),
  actor: fc.string(),
  action: fc.string(),
  target: fc.string(),
  detail: fc.string(),
});

describe("auditToLogLines (fuzz)", () => {
  it("is order- and length-preserving, and carries every field through verbatim", () => {
    fc.assert(
      fc.property(fc.array(eventArb), (events) => {
        const lines = auditToLogLines(events);
        expect(lines).toHaveLength(events.length);
        events.forEach((e, i) => {
          const line = lines[i];
          expect(line?.level).toBe("info");
          expect(line?.source).toBe(e.target);
          expect(line?.at).toBe(e.at);
          // The message interpolates action/actor/detail — none may be dropped/mangled.
          expect(line?.message).toContain(e.action);
          expect(line?.message).toContain(e.actor);
          expect(line?.message).toContain(e.detail);
        });
      }),
    );
  });
});
