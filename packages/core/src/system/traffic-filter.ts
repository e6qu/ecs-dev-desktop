// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Functional core for the admin traffic-filter policy. Pure model + validation +
 * compilation of an admin-authored policy into ordered AWS WAFv2 rule specs. No I/O:
 * the imperative shell (control plane) persists the policy and applies the compiled
 * rules to the WAFv2 Web ACL via the WAFv2 API.
 *
 * "Companies / clouds / hosters" are expressed as ASNs — the routable identity of a
 * network's owner. A curated name→ASN preset map ({@link NETWORK_PRESET_ASNS}) covers
 * the common clouds/hosters; admins can also enter raw ASNs. "Residential-only" is
 * approximated by AWS's managed anonymous-IP list (which flags hosting/VPN/proxy/Tor
 * sources — the inverse of residential), toggled via {@link TrafficFilterPolicy.blockAnonymous}.
 */

/** allow = only listed sources may reach the app (default-deny); block = listed
 * sources are denied (default-allow). One mode governs the whole policy. */
export type FilterMode = "allow" | "block";

export interface TrafficFilterPolicy {
  readonly version: 1;
  /** `allow` = allowlist (default-deny everything not matched); `block` = blocklist
   * (default-allow everything not matched). */
  readonly mode: FilterMode;
  /**
   * IPv4 CIDRs (e.g. "203.0.113.0/24"). IPv6 is intentionally rejected for now: the
   * live WAF is fronted by a single IPv4 WAFv2 IPSet, and a WAFv2 IPSet holds exactly
   * one address family, so an IPv6 entry would fail loudly only at apply time. IPv6
   * support is gated on provisioning a second (IPV6) IPSet — see DO_NEXT.
   */
  readonly cidrs: readonly string[];
  /** ISO 3166-1 alpha-2 country codes (e.g. "US", "DE"). */
  readonly countries: readonly string[];
  /** Autonomous System Numbers (e.g. 16509 for AWS). */
  readonly asns: readonly number[];
  /** Named cloud/hoster presets ({@link NETWORK_PRESET_ASNS} keys) — expanded to
   * their ASNs at compile time. */
  readonly presets: readonly string[];
  /** Block sources AWS classifies as anonymous (hosting/VPN/proxy/Tor). In `allow`
   * mode this is applied as an always-on block rule ABOVE the allowlist so a matched
   * allow entry that is also an anonymizer is still blocked. Approximates
   * "residential only" when the allowlist is broad. */
  readonly blockAnonymous: boolean;
}

/** The canonical empty policy: block mode, nothing listed, no managed blocks — i.e.
 * allow all (a no-op filter). New deployments start here. */
export const EMPTY_TRAFFIC_FILTER_POLICY: TrafficFilterPolicy = {
  version: 1,
  mode: "block",
  cidrs: [],
  countries: [],
  asns: [],
  presets: [],
  blockAnonymous: false,
};

/**
 * Curated cloud/hoster → ASN presets. Not exhaustive (networks add ASNs over time),
 * but covers the major clouds and hosting providers so an admin can block "all AWS"
 * or "all OVH" without hand-entering ASNs. Extend as needed; admins can always add
 * raw ASNs for anything missing.
 */
export const NETWORK_PRESET_ASNS: Readonly<Record<string, readonly number[]>> = {
  aws: [16509, 14618, 8987, 39111],
  gcp: [15169, 396982, 19527],
  azure: [8075, 8068, 8069, 12076],
  oracle: [31898, 7160],
  digitalocean: [14061],
  linode: [63949, 48429],
  ovh: [16276],
  hetzner: [24940, 213230],
  vultr: [20473],
  cloudflare: [13335],
};

/** Names admins may pass in {@link TrafficFilterPolicy.presets}. */
export const NETWORK_PRESETS: readonly string[] = Object.keys(NETWORK_PRESET_ASNS);

/** Strict IPv4 CIDR: each octet 0-255, prefix /0../32. IPv6 is deliberately NOT
 * accepted (single-family IPv4 IPSet — see {@link TrafficFilterPolicy.cidrs}). */
const IPV4_OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const CIDR_RE = new RegExp(`^(${IPV4_OCTET}\\.){3}${IPV4_OCTET}\\/(3[0-2]|[12]?[0-9])$`);
const COUNTRY_RE = /^[A-Z]{2}$/;
const ASN_MAX = 4_294_967_295; // 32-bit AS numbers

export interface PolicyIssue {
  readonly field: string;
  readonly value: string;
  readonly reason: string;
}

/** Pure validation: returns the list of problems (empty = valid). The shell rejects
 * an invalid policy loudly rather than applying a partial WAF config. */
export function validateTrafficFilterPolicy(policy: TrafficFilterPolicy): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  for (const cidr of policy.cidrs) {
    if (CIDR_RE.test(cidr)) continue;
    // A colon marks an IPv6-looking entry — reject with a specific reason.
    const reason = cidr.includes(":")
      ? "IPv6 is not supported yet (IPv4 CIDRs only)"
      : "not an IPv4 CIDR";
    issues.push({ field: "cidrs", value: cidr, reason });
  }
  for (const c of policy.countries) {
    if (!COUNTRY_RE.test(c))
      issues.push({ field: "countries", value: c, reason: "not an ISO alpha-2 code" });
  }
  for (const asn of policy.asns) {
    if (!Number.isInteger(asn) || asn <= 0 || asn > ASN_MAX)
      issues.push({ field: "asns", value: String(asn), reason: "not a valid AS number" });
  }
  for (const p of policy.presets) {
    if (!(p in NETWORK_PRESET_ASNS))
      issues.push({ field: "presets", value: p, reason: "unknown network preset" });
  }
  // Lockout guard: an `allow`-mode policy compiles to default-BLOCK, so if it admits
  // nothing (no cidrs/countries/asns/presets) it blocks ALL traffic — including the
  // admin who set it and the wake listener's login. That is never a valid save; require
  // at least one admit entry. (`block` mode with nothing listed is the harmless no-op
  // allow-all, so it stays valid.)
  if (
    policy.mode === "allow" &&
    policy.cidrs.length === 0 &&
    policy.countries.length === 0 &&
    policy.asns.length === 0 &&
    policy.presets.length === 0
  ) {
    issues.push({
      field: "mode",
      value: "allow",
      reason: "allow-mode policy admits no sources (would block all traffic)",
    });
  }
  return issues;
}

/** Every ASN a policy targets: its explicit ASNs plus the ASNs its presets expand to
 * (deduped, sorted). */
export function effectiveAsns(policy: TrafficFilterPolicy): readonly number[] {
  const set = new Set<number>(policy.asns);
  for (const preset of policy.presets) {
    for (const asn of NETWORK_PRESET_ASNS[preset] ?? []) set.add(asn);
  }
  return [...set].sort((a, b) => a - b);
}

/** A compiled WAFv2 rule: what the shell must materialize on the Web ACL. Statement
 * shapes mirror the WAFv2 API (IPSet/GeoMatch/AsnMatch/ManagedRuleGroup). */
export type CompiledRule =
  | { readonly kind: "ip"; readonly action: "allow" | "block"; readonly cidrs: readonly string[] }
  | {
      readonly kind: "geo";
      readonly action: "allow" | "block";
      readonly countries: readonly string[];
    }
  | { readonly kind: "asn"; readonly action: "allow" | "block"; readonly asns: readonly number[] }
  | { readonly kind: "managed-anonymous"; readonly action: "block" };

export interface CompiledTrafficFilter {
  readonly defaultAction: "allow" | "block";
  /** Rules in priority order (index 0 evaluated first). */
  readonly rules: readonly CompiledRule[];
}

/**
 * Compile a validated policy into an ordered rule set + default action:
 * - `allow` mode → default BLOCK, with an allow rule per non-empty match set; a
 *   `blockAnonymous` block rule is placed FIRST so an anonymizer that also matches an
 *   allow entry is still denied.
 * - `block` mode → default ALLOW, with a block rule per non-empty match set (plus the
 *   optional anonymous block).
 * Empty match sets are omitted (no vacuous rules). Throws on an invalid policy.
 */
export function compileTrafficFilter(policy: TrafficFilterPolicy): CompiledTrafficFilter {
  const issues = validateTrafficFilterPolicy(policy);
  if (issues.length > 0) {
    throw new Error(
      `invalid traffic-filter policy: ${issues
        .map((i) => `${i.field}=${i.value} (${i.reason})`)
        .join(", ")}`,
    );
  }
  const asns = effectiveAsns(policy);
  const rules: CompiledRule[] = [];
  // An anonymous-source block always takes precedence, in either mode.
  if (policy.blockAnonymous) rules.push({ kind: "managed-anonymous", action: "block" });

  const matchAction: "allow" | "block" = policy.mode === "allow" ? "allow" : "block";
  if (policy.cidrs.length > 0) rules.push({ kind: "ip", action: matchAction, cidrs: policy.cidrs });
  if (policy.countries.length > 0)
    rules.push({ kind: "geo", action: matchAction, countries: policy.countries });
  if (asns.length > 0) rules.push({ kind: "asn", action: matchAction, asns });

  return { defaultAction: policy.mode === "allow" ? "block" : "allow", rules };
}
