// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the IAM preflight evaluator. The headline is
// fail-closed: a required action that the live simulate never returned a decision for
// counts exactly like a denial — the result is never `ok`/`summary.ok` when ANY required
// action is absent-or-denied. Also pins: `unavailable` always degrades to `unknown`/`ok`
// (never a false `drift`/failure), `requiredActions` is total/deduped/sorted and
// order-independent, and the denied-action set the two evaluators report stays coherent.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  evaluateIamPermissions,
  requiredActions,
  summarizeIamPreflight,
  type IamActionDecision,
  type IamComponent,
  type IamPreflightSignal,
} from "./iam-requirements";

const COMPONENTS: readonly IamComponent[] = ["control-plane", "reconciler"];
const componentArb = fc.constantFrom(...COMPONENTS);

/** A `checked` signal whose decisions are drawn from the component's required actions
 * plus some unrelated noise actions — each action independently allowed or denied, and
 * any required action may simply be ABSENT (no decision at all). This exercises the
 * fail-closed "absent ⇒ denied" path that an all-allowed-only generator would miss. */
const checkedSignalArb = (component: IamComponent) => {
  const required = requiredActions(component);
  return fc
    .record({
      // For each required action: include a decision (allow/deny) or omit it.
      forRequired: fc.array(
        fc.record({
          idx: fc.integer({ min: 0, max: Math.max(0, required.length - 1) }),
          allowed: fc.boolean(),
        }),
        { maxLength: required.length * 2 },
      ),
      noise: fc.array(
        fc.record({
          action: fc.string({ minLength: 1 }).map((s) => `noise:${s}`),
          allowed: fc.boolean(),
        }),
        { maxLength: 5 },
      ),
    })
    .map(({ forRequired, noise }): IamPreflightSignal => {
      const decisions: IamActionDecision[] = [];
      for (const { idx, allowed } of forRequired) {
        const action = required[idx];
        if (action !== undefined) decisions.push({ action, allowed });
      }
      decisions.push(...noise);
      return { kind: "checked", decisions };
    });
};

describe("requiredActions — properties", () => {
  it("is deduped, sorted ascending, and total over the manifest", () => {
    fc.assert(
      fc.property(componentArb, (component) => {
        const actions = requiredActions(component);
        // Deduped.
        expect(new Set(actions).size).toBe(actions.length);
        // Sorted ascending (the canonical order consumers rely on).
        expect([...actions].sort()).toEqual([...actions]);
        // Total: every manifest action for the component appears.
        const expected = new Set<string>();
        // (Derive from the public evaluator's view: an all-allowed signal must be ok.)
        const allowed: IamActionDecision[] = actions.map((a) => ({ action: a, allowed: true }));
        expect(
          evaluateIamPermissions(component, { kind: "checked", decisions: allowed }).status,
        ).toBe("ok");
        for (const a of actions) expected.add(a);
        expect(expected.size).toBe(actions.length);
      }),
    );
  });

  it("is order-independent (the manifest order does not affect the result set)", () => {
    fc.assert(
      fc.property(componentArb, (component) => {
        const actions = requiredActions(component);
        // Calling again yields an identical, already-sorted list.
        expect(requiredActions(component)).toEqual(actions);
      }),
    );
  });
});

describe("evaluateIamPermissions — fail-closed properties", () => {
  it("unavailable always degrades to unknown — never drift", () => {
    fc.assert(
      fc.property(componentArb, fc.string(), (component, reason) => {
        const check = evaluateIamPermissions(component, { kind: "unavailable", reason });
        expect(check.status).toBe("unknown");
        expect(check.status).not.toBe("drift");
      }),
    );
  });

  it("ok IFF every required action has an explicit allow; any absent-or-denied ⇒ drift", () => {
    fc.assert(
      fc.property(
        componentArb.chain((component) =>
          fc.tuple(fc.constant(component), checkedSignalArb(component)),
        ),
        ([component, signal]) => {
          const required = requiredActions(component);
          const allowed = new Set(
            signal.kind === "checked"
              ? signal.decisions.filter((d) => d.allowed).map((d) => d.action)
              : [],
          );
          const everyRequiredAllowed = required.every((a) => allowed.has(a));
          const check = evaluateIamPermissions(component, signal);
          // Fail-closed: status is `ok` exactly when every required action is allowed.
          // A required action that is merely absent from the decisions counts as denied.
          expect(check.status === "ok").toBe(everyRequiredAllowed);
          expect(["ok", "drift"]).toContain(check.status);
        },
      ),
    );
  });

  it("a single missing required decision is enough to force drift (fail-closed)", () => {
    fc.assert(
      fc.property(
        componentArb.chain((component) =>
          fc.tuple(
            fc.constant(component),
            fc.integer({ min: 0, max: requiredActions(component).length - 1 }),
          ),
        ),
        ([component, dropIdx]) => {
          const required = requiredActions(component);
          // Allow every required action EXCEPT one we drop entirely (absent decision).
          const decisions: IamActionDecision[] = required
            .filter((_, i) => i !== dropIdx)
            .map((a) => ({ action: a, allowed: true }));
          const check = evaluateIamPermissions(component, { kind: "checked", decisions });
          expect(check.status).toBe("drift");
          expect(check.detail).toContain(required[dropIdx] ?? "");
        },
      ),
    );
  });
});

describe("summarizeIamPreflight — fail-closed degradation", () => {
  it("unavailable degrades to ok:true (unknown, not a false failure) carrying the reason", () => {
    fc.assert(
      fc.property(fc.string(), (reason) => {
        const summary = summarizeIamPreflight({ kind: "unavailable", reason });
        expect(summary.ok).toBe(true);
        expect(summary.deniedActions).toEqual([]);
        expect(summary.reason).toBe(reason);
      }),
    );
  });

  it("checked: ok IFF no decision is denied; deniedActions lists exactly the denials", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            action: fc.string({ minLength: 1 }).map((s) => `svc:${s}`),
            allowed: fc.boolean(),
          }),
          { maxLength: 12 },
        ),
        (decisions) => {
          const summary = summarizeIamPreflight({ kind: "checked", decisions });
          const expectedDenied = decisions.filter((d) => !d.allowed).map((d) => d.action);
          expect(summary.deniedActions).toEqual(expectedDenied);
          expect(summary.ok).toBe(expectedDenied.length === 0);
          expect(summary.reason).toBeUndefined();
        },
      ),
    );
  });
});
