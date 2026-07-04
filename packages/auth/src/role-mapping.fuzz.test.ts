// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mapClaimsToRole, type IdentityClaims, type Role } from "./index";

const groupId = fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{0,30}$/);
const ROLES: readonly Role[] = ["viewer", "member", "admin"];

interface DisjointConfig {
  /** Head is always present (a non-empty group set); the rest is the tail. */
  adminGroups: string[];
  adminHead: string;
  memberGroups: string[];
  memberHead: string;
  defaultRole: Role;
}

// Build each group set as head + tail so the first element is statically a string
// (no array-index undefined under noUncheckedIndexedAccess, no casts).
const groupSet = fc
  .tuple(groupId, fc.uniqueArray(groupId, { maxLength: 3 }))
  .map(([head, tail]) => ({ head, all: [head, ...tail.filter((g) => g !== head)] }));

const configArb: fc.Arbitrary<DisjointConfig> = fc
  .record({
    admin: groupSet,
    member: groupSet,
    defaultRole: fc.constantFrom<Role>("viewer", "member", "admin"),
  })
  // Keep admin/member group sets disjoint so precedence is unambiguous.
  .filter((c) => !c.admin.all.some((g) => c.member.all.includes(g)))
  .map((c) => ({
    adminGroups: c.admin.all,
    adminHead: c.admin.head,
    memberGroups: c.member.all,
    memberHead: c.member.head,
    defaultRole: c.defaultRole,
  }));

const claimsWith = (groups: string[]): IdentityClaims => ({
  idp: "github",
  subject: "u",
  groups,
});

describe("mapClaimsToRole (property)", () => {
  it("always returns a role in {viewer, member, admin}", () => {
    fc.assert(
      fc.property(configArb, fc.array(fc.string(), { maxLength: 8 }), (config, groups) => {
        expect(ROLES).toContain(mapClaimsToRole(claimsWith(groups), config));
      }),
    );
  });

  it("matches groups case-insensitively (same group, random casing → same role)", () => {
    // Flat property: generate config + group + casing flags in one pass.
    // No nested fc.assert (which would be O(N²) at 5000 runs).
    const arb = fc
      .tuple(configArb, fc.nat({ max: 1 }), fc.array(fc.boolean(), { maxLength: 31, minLength: 1 }))
      .map(([config, groupIdx, flags]) => {
        const group = groupIdx === 0 ? config.adminHead : config.memberHead;
        const recased = Array.from(group)
          .map((ch, i) => (flags[i] === true ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        return { config, group, recased };
      });
    fc.assert(
      fc.property(arb, ({ config, group, recased }) => {
        const baseline = mapClaimsToRole(claimsWith([group]), config);
        const recasedRole = mapClaimsToRole(claimsWith([recased]), config);
        expect(recasedRole).toBe(baseline);
      }),
    );
  });

  it("admin precedence: an admin group wins even alongside a member group", () => {
    fc.assert(
      fc.property(configArb, (config) => {
        const groups = [config.adminHead, config.memberHead];
        expect(mapClaimsToRole(claimsWith(groups), config)).toBe("admin");
      }),
    );
  });

  it("an extra unrelated group never downgrades the resolved role", () => {
    const unrelated = fc.string().filter((s) => s.trim().length > 0);
    fc.assert(
      fc.property(configArb, fc.array(unrelated, { maxLength: 5 }), (config, extras) => {
        // Drop any "unrelated" group that actually collides with a configured group.
        const configured = new Set(
          [...config.adminGroups, ...config.memberGroups].map((g) => g.toLowerCase()),
        );
        const safeExtras = extras.filter((e) => !configured.has(e.toLowerCase()));
        for (const base of [config.adminHead, config.memberHead]) {
          const without = mapClaimsToRole(claimsWith([base]), config);
          const withExtras = mapClaimsToRole(claimsWith([base, ...safeExtras]), config);
          // viewer < member < admin
          expect(ROLES.indexOf(withExtras)).toBeGreaterThanOrEqual(ROLES.indexOf(without));
        }
      }),
    );
  });
});
