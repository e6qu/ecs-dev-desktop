// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  EMPTY_TRAFFIC_FILTER_POLICY,
  compileTrafficFilter,
  effectiveAsns,
  validateTrafficFilterPolicy,
  type TrafficFilterPolicy,
} from "./traffic-filter";

const base: TrafficFilterPolicy = EMPTY_TRAFFIC_FILTER_POLICY;

describe("validateTrafficFilterPolicy", () => {
  it("accepts the empty policy", () => {
    expect(validateTrafficFilterPolicy(base)).toEqual([]);
  });

  it("flags a bad CIDR, country, ASN, and preset", () => {
    const issues = validateTrafficFilterPolicy({
      ...base,
      cidrs: ["10.0.0.0/8", "not-a-cidr"],
      countries: ["US", "usa"],
      asns: [16509, -1],
      presets: ["aws", "nope"],
    });
    expect(issues.map((i) => i.field).sort()).toEqual(["asns", "cidrs", "countries", "presets"]);
  });
});

describe("effectiveAsns", () => {
  it("expands presets and dedupes/sorts with explicit ASNs", () => {
    const asns = effectiveAsns({ ...base, asns: [16509, 999], presets: ["aws"] });
    expect(asns).toContain(16509); // both an explicit AWS asn and in the preset
    expect(asns).toContain(999);
    // sorted ascending, deduped
    expect(asns).toEqual([...asns].sort((a, b) => a - b));
    expect(new Set(asns).size).toBe(asns.length);
  });
});

describe("compileTrafficFilter", () => {
  it("allow mode → default block, one allow rule per non-empty set", () => {
    const c = compileTrafficFilter({
      ...base,
      mode: "allow",
      cidrs: ["203.0.113.0/24"],
      countries: ["US"],
    });
    expect(c.defaultAction).toBe("block");
    expect(c.rules.map((r) => `${r.kind}:${r.action}`)).toEqual(["ip:allow", "geo:allow"]);
  });

  it("block mode → default allow, one block rule per non-empty set", () => {
    const c = compileTrafficFilter({ ...base, mode: "block", asns: [16509], presets: ["ovh"] });
    expect(c.defaultAction).toBe("allow");
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]).toMatchObject({ kind: "asn", action: "block" });
  });

  it("places the anonymous block FIRST in allow mode (an anonymizer in the allowlist is still denied)", () => {
    const c = compileTrafficFilter({
      ...base,
      mode: "allow",
      blockAnonymous: true,
      cidrs: ["203.0.113.0/24"],
    });
    expect(c.rules[0]).toEqual({ kind: "managed-anonymous", action: "block" });
    expect(c.rules[1]).toMatchObject({ kind: "ip", action: "allow" });
  });

  it("omits vacuous rules for empty match sets", () => {
    expect(compileTrafficFilter(base).rules).toEqual([]);
  });

  it("throws on an invalid policy rather than applying a partial WAF config", () => {
    expect(() => compileTrafficFilter({ ...base, cidrs: ["bad"] })).toThrow(/invalid traffic-filter/);
  });
});
