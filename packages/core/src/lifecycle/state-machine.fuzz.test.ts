// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the workspace lifecycle state machine + the
// connect planner. These pin the cross-table invariants that example tests can't
// exhaustively cover: the `transition`/`can` tables can never drift, `terminated` is
// absorbing, every UI-offered action is a legal transition, and `planConnect` agrees
// with the machine.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isErr, isOk } from "../result";
import { planConnect } from "./connect";
import {
  can,
  transition,
  workspaceActions,
  type WorkspaceAction,
  type WorkspaceEvent,
  type WorkspaceState,
} from "./workspace-state-machine";

const STATES: readonly WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "deleting",
  "terminated",
  "error",
];
const EVENTS: readonly WorkspaceEvent[] = [
  "provisioned",
  "activity",
  "idleTimeout",
  "stop",
  "wake",
  "terminate",
  "requestDelete",
  "recover",
  "fail",
];
const CONNECT_ACTIONS = ["ready", "wake", "pending", "unavailable"] as const;

const stateArb = fc.constantFrom(...STATES);
const eventArb = fc.constantFrom(...EVENTS);

describe("workspace state machine — properties", () => {
  it("transition() is ok exactly when can() agrees, never throws, and yields a valid state", () => {
    fc.assert(
      fc.property(stateArb, eventArb, (s, e) => {
        const r = transition(s, e);
        expect(isOk(r)).toBe(can(s, e));
        if (isOk(r)) expect(STATES).toContain(r.value);
      }),
    );
  });

  it("`terminated` admits ONLY `undelete` (→ stopped) — everything else is absorbed", () => {
    fc.assert(
      fc.property(eventArb, (e) => {
        const r = transition("terminated", e);
        if (e === "undelete") {
          expect(isOk(r)).toBe(true);
          if (isOk(r)) expect(r.value).toBe("stopped");
        } else {
          expect(isErr(r)).toBe(true);
        }
      }),
    );
  });

  it("every offered start/stop/delete action maps to a legal transition from its state", () => {
    const ACTION_EVENT: Partial<Record<WorkspaceAction, WorkspaceEvent>> = {
      start: "wake",
      stop: "stop",
      delete: "requestDelete",
      undelete: "undelete",
    };
    fc.assert(
      fc.property(stateArb, (s) => {
        for (const a of workspaceActions(s)) {
          const ev = ACTION_EVENT[a];
          if (ev !== undefined) expect(can(s, ev)).toBe(true);
        }
      }),
    );
  });

  it("planConnect is total and plans `wake` exactly when `wake` is a legal event", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const plan = planConnect(s);
        expect(CONNECT_ACTIONS).toContain(plan);
        expect(plan === "wake").toBe(can(s, "wake"));
      }),
    );
  });
});
