// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for overlayTopologyHealth. The overlay preserves the
// static graph exactly (output length === node count, ids in order, no fabrication) and a
// node with NO matching live check is always `unknown` — never a fabricated `ok`. A node
// whose id matches a reported component takes that component's status + detail verbatim.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ComponentHealth, HealthStatus } from "./health";
import { overlayTopologyHealth, SYSTEM_TOPOLOGY } from "./topology";

const NODE_IDS = SYSTEM_TOPOLOGY.nodes.map((n) => n.id);
const statusArb = fc.constantFrom<HealthStatus>("ok", "degraded", "down", "unknown");

// Components: a subset of real node ids (so some match), plus some ids that match nothing.
const componentArb = (id: string): fc.Arbitrary<ComponentHealth> =>
  fc.record({
    component: fc.constant(id),
    status: statusArb,
    detail: fc.option(fc.string(), { nil: undefined }),
  });

const componentsArb = fc
  .record({
    matching: fc.subarray([...NODE_IDS], { minLength: 0 }),
    extra: fc.array(
      fc.string({ minLength: 1 }).map((s) => `nomatch-${s}`),
      { maxLength: 5 },
    ),
  })
  .chain(({ matching, extra }) =>
    fc.tuple(...[...matching, ...extra].map((id) => componentArb(id))),
  )
  .map((cs): ComponentHealth[] => [...cs]);

describe("overlayTopologyHealth — properties", () => {
  it("preserves node count, ids, and order; never fabricates or drops a node", () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        const out = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
        expect(out.length).toBe(SYSTEM_TOPOLOGY.nodes.length);
        expect(out.map((n) => n.id)).toEqual(NODE_IDS);
        // Static node fields are carried through verbatim.
        out.forEach((n, i) => {
          const src = SYSTEM_TOPOLOGY.nodes[i];
          expect(src).toBeDefined();
          expect(n.label).toBe(src?.label);
          expect(n.kind).toBe(src?.kind);
          expect(n.description).toBe(src?.description);
        });
      }),
    );
  });

  it("an unmatched node is always `unknown` — never a fabricated `ok`", () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        const reported = new Set(components.map((c) => c.component));
        const out = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
        for (const node of out) {
          if (!reported.has(node.id)) {
            expect(node.status).toBe("unknown");
            expect(node.detail).toBeUndefined();
          }
        }
      }),
    );
  });

  it("a matched node takes its component's status and detail verbatim", () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        // Last write wins per the Map construction (later duplicate component ids overwrite).
        const byId = new Map(components.map((c) => [c.component, c]));
        const out = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
        for (const node of out) {
          const health = byId.get(node.id);
          if (health !== undefined) {
            expect(node.status).toBe(health.status);
            expect(node.detail).toBe(health.detail);
          }
        }
      }),
    );
  });

  it("an empty health report leaves every node `unknown`", () => {
    const out = overlayTopologyHealth(SYSTEM_TOPOLOGY, []);
    expect(out.length).toBe(SYSTEM_TOPOLOGY.nodes.length);
    for (const node of out) expect(node.status).toBe("unknown");
  });
});
