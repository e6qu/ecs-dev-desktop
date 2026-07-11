// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin traffic-filter service — the imperative shell over the pure `@edd/core`
 * traffic-filter policy model. It persists the admin-authored policy (one fixed-id
 * DynamoDB row) and applies the COMPILED rule set to the live CLOUDFRONT-scope WAFv2
 * Web ACL through the injected {@link WafApplier} port.
 *
 * All the DECISION logic — validation, mode semantics, and the ordered rule
 * compilation — lives in the pure core (`compileTrafficFilter`); this shell only
 * reads/writes the one row, invokes the WAF boundary, and records the apply outcome.
 * The WAF adapter is a port so the service is unit/integration-testable with a fake
 * applier and the sim's DynamoDB, with zero AWS-vs-sim branching (§6.9).
 */
import {
  compileTrafficFilter,
  EMPTY_TRAFFIC_FILTER_POLICY,
  NETWORK_PRESETS,
  type Clock,
  type CompiledRule,
  type CompiledTrafficFilter,
  type TrafficFilterPolicy,
} from "@edd/core";
import type {
  CompiledFilterRuleDto,
  TrafficFilterPolicyDto,
  TrafficFilterStateDto,
} from "@edd/api-contracts";
import { TRAFFIC_FILTER_POLICY_ID, type TrafficFilterEntity } from "@edd/db";

import type { AuditAction } from "./stored-audit-source";

/**
 * Persisted-state schema version (§6.5a). Bump whenever the stored shape changes;
 * `getState` accepts ONLY this version and otherwise discards the stale blob and
 * falls back to the empty (allow-all) policy, so an older row can never be read into
 * newer code with an absent field.
 */
export const TRAFFIC_FILTER_SCHEMA_VERSION = 1;

/**
 * Boundary to the live AWS WAFv2 Web ACL. The shell hands it the compiled policy and
 * it materializes the rules (IPSet / GeoMatch / AsnMatch / managed-anonymous) on the
 * CLOUDFRONT-scope Web ACL. A pure port: injected, faked in tests, real over the
 * WAFv2 SDK in `apps/web/lib/waf-applier.ts`.
 */
export interface WafApplier {
  apply(compiled: CompiledTrafficFilter): Promise<void>;
}

/** The narrow audit-record capability the service needs (the `StoredAuditSource`
 * satisfies it). Kept minimal so the service is faked without a full audit stack. */
export interface TrafficFilterAuditRecorder {
  record(action: AuditAction): Promise<void>;
}

export interface TrafficFilterServiceDeps {
  /** The `trafficFilterPolicy` single-table entity (from `@edd/db`). */
  store: TrafficFilterEntity;
  /** The live-WAFv2 boundary. */
  waf: WafApplier;
  clock: Clock;
  /** Actor-attributed audit log — each policy change is recorded. */
  audit: TrafficFilterAuditRecorder;
}

/** Raised when applying the compiled policy to the live WAF fails. The route maps it
 * to a 5xx with the underlying message (the policy IS persisted; only the apply
 * failed, and the failure is recorded on the row for `getState`). */
export class WafApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WafApplyError";
  }
}

/**
 * Reads + writes the singleton traffic-filter policy and applies it to the live WAF.
 * The service owns no policy semantics — it delegates every decision to the pure core
 * (`compileTrafficFilter`, which throws on an invalid policy = fail loud, §6.5).
 */
export class TrafficFilterService {
  constructor(private readonly deps: TrafficFilterServiceDeps) {}

  /**
   * The current traffic-filter state: the persisted policy (or the empty allow-all
   * policy when none is stored / the stored row is a stale schema version), its
   * compiled rule preview + default action, the available presets, and the outcome of
   * the last apply to the live WAF.
   */
  async getState(): Promise<TrafficFilterStateDto> {
    const loaded = await this.load();
    const compiled = compileTrafficFilter(loaded.policy);
    return {
      policy: toPolicyDto(loaded.policy),
      defaultAction: compiled.defaultAction,
      compiled: compiled.rules.map(toCompiledRuleDto),
      presets: [...NETWORK_PRESETS],
      ...(loaded.appliedAt === undefined ? {} : { appliedAt: loaded.appliedAt }),
      ...(loaded.appliedError === undefined ? {} : { appliedError: loaded.appliedError }),
    };
  }

  /**
   * Replace the policy and apply it to the live WAF. Validates by compiling (throws
   * on an invalid policy BEFORE any write), persists the versioned row, applies the
   * compiled rules to the WAF, records `appliedAt` on success or `appliedError` on
   * failure, and audits the change. On a WAF apply failure the policy stays persisted
   * (with the recorded error) and a {@link WafApplyError} is thrown for the caller.
   */
  async updatePolicy(policy: TrafficFilterPolicy, actor: string): Promise<TrafficFilterStateDto> {
    // Compile first: an invalid policy throws here, before we touch storage or WAF.
    const compiled = compileTrafficFilter(policy);
    const updatedAt = this.deps.clock.now();

    // Persist the policy BEFORE applying, so a crash mid-apply leaves the intended
    // policy durable (with no recorded apply outcome yet — a subsequent getState/apply
    // reconciles it).
    await this.persist(policy, updatedAt, { appliedAt: undefined, appliedError: undefined });

    try {
      await this.deps.waf.apply(compiled);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.persist(policy, updatedAt, { appliedAt: undefined, appliedError: message });
      await this.deps.audit.record({
        actor,
        action: "traffic-filter.apply-failed",
        target: TRAFFIC_FILTER_POLICY_ID,
        detail: `mode=${policy.mode}; WAF apply failed: ${message}`,
      });
      throw new WafApplyError(`traffic-filter WAF apply failed: ${message}`);
    }

    const appliedAt = this.deps.clock.now();
    await this.persist(policy, updatedAt, { appliedAt, appliedError: undefined });
    await this.deps.audit.record({
      actor,
      action: "traffic-filter.updated",
      target: TRAFFIC_FILTER_POLICY_ID,
      detail: describePolicy(policy, compiled),
    });
    return this.getState();
  }

  /** Load + validate the persisted row (or the empty policy when absent/stale). */
  private async load(): Promise<{
    policy: TrafficFilterPolicy;
    appliedAt?: string;
    appliedError?: string;
  }> {
    const r = await this.deps.store.get({ id: TRAFFIC_FILTER_POLICY_ID }).go();
    if (r.data?.schemaVersion !== TRAFFIC_FILTER_SCHEMA_VERSION) {
      return { policy: EMPTY_TRAFFIC_FILTER_POLICY };
    }
    const d = r.data;
    const policy: TrafficFilterPolicy = {
      version: 1,
      mode: d.mode,
      cidrs: d.cidrs,
      countries: d.countries,
      asns: d.asns,
      presets: d.presets,
      blockAnonymous: d.blockAnonymous,
    };
    return {
      policy,
      ...(d.appliedAt === undefined ? {} : { appliedAt: d.appliedAt }),
      ...(d.appliedError === undefined ? {} : { appliedError: d.appliedError }),
    };
  }

  /** Write the full versioned row (single-row put — the latest write wins). */
  private async persist(
    policy: TrafficFilterPolicy,
    updatedAt: string,
    outcome: { appliedAt: string | undefined; appliedError: string | undefined },
  ): Promise<void> {
    await this.deps.store
      .put({
        id: TRAFFIC_FILTER_POLICY_ID,
        schemaVersion: TRAFFIC_FILTER_SCHEMA_VERSION,
        mode: policy.mode,
        cidrs: [...policy.cidrs],
        countries: [...policy.countries],
        asns: [...policy.asns],
        presets: [...policy.presets],
        blockAnonymous: policy.blockAnonymous,
        ...(outcome.appliedAt === undefined ? {} : { appliedAt: outcome.appliedAt }),
        ...(outcome.appliedError === undefined ? {} : { appliedError: outcome.appliedError }),
        updatedAt,
      })
      .go();
  }
}

function toPolicyDto(policy: TrafficFilterPolicy): TrafficFilterPolicyDto {
  return {
    version: 1,
    mode: policy.mode,
    cidrs: [...policy.cidrs],
    countries: [...policy.countries],
    asns: [...policy.asns],
    presets: [...policy.presets],
    blockAnonymous: policy.blockAnonymous,
  };
}

/** Human-readable preview of a compiled WAF rule for the admin console. */
function toCompiledRuleDto(rule: CompiledRule): CompiledFilterRuleDto {
  return { kind: rule.kind, action: rule.action, detail: describeRule(rule) };
}

function describeRule(rule: CompiledRule): string {
  switch (rule.kind) {
    case "ip":
      return `${rule.action} ${rule.cidrs.length.toString()} CIDR${rule.cidrs.length === 1 ? "" : "s"}: ${rule.cidrs.join(", ")}`;
    case "geo":
      return `${rule.action} ${rule.countries.length.toString()} countr${rule.countries.length === 1 ? "y" : "ies"}: ${rule.countries.join(", ")}`;
    case "asn":
      return `${rule.action} ${rule.asns.length.toString()} ASN${rule.asns.length === 1 ? "" : "s"}: ${rule.asns.join(", ")}`;
    case "managed-anonymous":
      return "block anonymous sources (hosting/VPN/proxy/Tor)";
  }
}

function describePolicy(policy: TrafficFilterPolicy, compiled: CompiledTrafficFilter): string {
  return `mode=${policy.mode}; default=${compiled.defaultAction}; ${compiled.rules.length.toString()} compiled rule${compiled.rules.length === 1 ? "" : "s"} applied to WAF`;
}
