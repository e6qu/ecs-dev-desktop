// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Real {@link WafApplier} over `@aws-sdk/client-wafv2`: materializes a compiled
 * traffic-filter policy onto the live CLOUDFRONT-scope WAFv2 Web ACL.
 *
 * The Web ACL + IPSet are provisioned out of band by Terraform; this only reads
 * their coordinates from env and MUTATES them:
 *   - the `ip` rule's CIDRs become the referenced IPSet's addresses
 *     (`GetIPSet` → `UpdateIPSet` with the returned `LockToken`), and
 *   - the geo / asn / managed-anonymous statements plus the default action are
 *     written onto the Web ACL (`GetWebACL` → `UpdateWebACL` with its `LockToken`,
 *     preserving the ACL's own `VisibilityConfig`).
 *
 * Endpoint-only (§6.9): the CLOUDFRONT scope pins the region to `us-east-1`; the SDK
 * reaches the sim vs real AWS by `AWS_ENDPOINT_URL` alone — no sim branch. Coordinates
 * (ACL/IPSet id+name) come from env; a missing coordinate at apply time fails loudly.
 * `getState` never calls the applier, so the admin page renders without WAF env set.
 *
 * ASN support: this SDK version (`@aws-sdk/client-wafv2@3.1084.0`) DOES expose
 * `AsnMatchStatement`, so ASN rules are emitted natively — no IPSet fallback needed.
 */
import {
  GetIPSetCommand,
  GetWebACLCommand,
  UpdateIPSetCommand,
  UpdateWebACLCommand,
  WAFV2Client,
  type CountryCode,
  type DefaultAction,
  type GetIPSetCommandOutput,
  type GetWebACLCommandOutput,
  type Rule,
  type UpdateIPSetCommandOutput,
  type UpdateWebACLCommandOutput,
} from "@aws-sdk/client-wafv2";
import { AWS_SDK_MAX_ATTEMPTS, AWS_SDK_RETRY_MODE } from "@edd/config";
import type { CompiledRule, CompiledTrafficFilter } from "@edd/core";
import type { WafApplier } from "@edd/control-plane";

/** CLOUDFRONT-scope Web ACLs are global and MUST be managed from us-east-1. */
const WAF_REGION = "us-east-1";
/** WAFv2 scope for a CloudFront-fronted distribution. */
const WAF_SCOPE = "CLOUDFRONT" as const;
/** AWS-managed rule group that flags anonymizing sources (hosting/VPN/proxy/Tor). */
const ANONYMOUS_IP_VENDOR = "AWS";
const ANONYMOUS_IP_RULE_GROUP = "AWSManagedRulesAnonymousIpList";

/** Env coordinate names for the out-of-band Web ACL + IPSet (Terraform-provisioned). */
export const WAF_WEB_ACL_ID_ENV = "EDD_WAF_WEB_ACL_ID";
export const WAF_WEB_ACL_NAME_ENV = "EDD_WAF_WEB_ACL_NAME";
export const WAF_IP_SET_ID_ENV = "EDD_WAF_IP_SET_ID";
export const WAF_IP_SET_NAME_ENV = "EDD_WAF_IP_SET_NAME";

/** Per-rule metric/name stems (WAFv2 requires alphanumeric metric names). */
const RULE_META: Record<CompiledRule["kind"], { name: string; metric: string }> = {
  ip: { name: "EddTrafficIp", metric: "EddTrafficIp" },
  geo: { name: "EddTrafficGeo", metric: "EddTrafficGeo" },
  asn: { name: "EddTrafficAsn", metric: "EddTrafficAsn" },
  "managed-anonymous": { name: "EddTrafficAnonymous", metric: "EddTrafficAnonymous" },
};

interface WafCoordinates {
  webAclId: string;
  webAclName: string;
  ipSetId: string;
  ipSetName: string;
}

/**
 * The narrow slice of the WAFv2 API this adapter uses. The real `WAFV2Client`
 * satisfies it; tests supply a fake with the four typed methods (no overloads, no
 * `any`) so the emitted IPSet/WebACL update SHAPES are asserted without AWS.
 */
export interface Wafv2Port {
  getIpSet(command: GetIPSetCommand): Promise<GetIPSetCommandOutput>;
  updateIpSet(command: UpdateIPSetCommand): Promise<UpdateIPSetCommandOutput>;
  getWebAcl(command: GetWebACLCommand): Promise<GetWebACLCommandOutput>;
  updateWebAcl(command: UpdateWebACLCommand): Promise<UpdateWebACLCommandOutput>;
}

/** Default port over the real `WAFV2Client` (us-east-1 for the CLOUDFRONT scope). */
function realPort(): Wafv2Port {
  const client = new WAFV2Client({
    region: WAF_REGION,
    maxAttempts: AWS_SDK_MAX_ATTEMPTS,
    retryMode: AWS_SDK_RETRY_MODE,
  });
  return {
    getIpSet: (command) => client.send(command),
    updateIpSet: (command) => client.send(command),
    getWebAcl: (command) => client.send(command),
    updateWebAcl: (command) => client.send(command),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required to apply the traffic filter to the live WAF`);
  }
  return value;
}

/**
 * The real WAF applier. Constructing it is cheap (no env read, no network), so it can
 * back `getState` too; the coordinates are read (and validated) only when `apply`
 * actually mutates the live WAF.
 */
export class RealWafApplier implements WafApplier {
  constructor(private readonly port: Wafv2Port = realPort()) {}

  async apply(compiled: CompiledTrafficFilter): Promise<void> {
    const coords = this.coordinates();

    // 1) Materialize the IPSet: the ip rule's CIDRs become the IPSet addresses (or []
    //    when the policy has no ip rule — clearing any stale addresses). Capture the
    //    IPSet ARN for the Web ACL's IPSetReferenceStatement.
    const ipRule = compiled.rules.find(
      (r): r is Extract<CompiledRule, { kind: "ip" }> => r.kind === "ip",
    );
    const ipSetArn = await this.materializeIpSet(coords, ipRule?.cidrs ?? []);

    // 2) Materialize the Web ACL: geo / asn / managed-anonymous statements + the ip
    //    reference statement, in the compiled order, plus the default action.
    await this.materializeWebAcl(coords, compiled, ipSetArn);
  }

  private coordinates(): WafCoordinates {
    return {
      webAclId: requireEnv(WAF_WEB_ACL_ID_ENV),
      webAclName: requireEnv(WAF_WEB_ACL_NAME_ENV),
      ipSetId: requireEnv(WAF_IP_SET_ID_ENV),
      ipSetName: requireEnv(WAF_IP_SET_NAME_ENV),
    };
  }

  private async materializeIpSet(
    coords: WafCoordinates,
    cidrs: readonly string[],
  ): Promise<string> {
    const current = await this.port.getIpSet(
      new GetIPSetCommand({ Name: coords.ipSetName, Scope: WAF_SCOPE, Id: coords.ipSetId }),
    );
    const lockToken = current.LockToken;
    const arn = current.IPSet?.ARN;
    if (lockToken === undefined) throw new Error("WAFv2 GetIPSet returned no LockToken");
    if (arn === undefined) throw new Error("WAFv2 GetIPSet returned no IPSet ARN");
    await this.port.updateIpSet(
      new UpdateIPSetCommand({
        Name: coords.ipSetName,
        Scope: WAF_SCOPE,
        Id: coords.ipSetId,
        Addresses: [...cidrs],
        LockToken: lockToken,
      }),
    );
    return arn;
  }

  private async materializeWebAcl(
    coords: WafCoordinates,
    compiled: CompiledTrafficFilter,
    ipSetArn: string,
  ): Promise<void> {
    const current = await this.port.getWebAcl(
      new GetWebACLCommand({ Name: coords.webAclName, Scope: WAF_SCOPE, Id: coords.webAclId }),
    );
    const lockToken = current.LockToken;
    const visibility = current.WebACL?.VisibilityConfig;
    if (lockToken === undefined) throw new Error("WAFv2 GetWebACL returned no LockToken");
    if (visibility === undefined) throw new Error("WAFv2 GetWebACL returned no VisibilityConfig");

    const rules = compiled.rules.map((rule, index) => toWafRule(rule, index, ipSetArn));
    const defaultAction: DefaultAction =
      compiled.defaultAction === "allow" ? { Allow: {} } : { Block: {} };

    await this.port.updateWebAcl(
      new UpdateWebACLCommand({
        Name: coords.webAclName,
        Scope: WAF_SCOPE,
        Id: coords.webAclId,
        DefaultAction: defaultAction,
        Rules: rules,
        VisibilityConfig: visibility,
        LockToken: lockToken,
      }),
    );
  }
}

/** One compiled rule → one WAFv2 `Rule` (priority = compiled order). */
function toWafRule(rule: CompiledRule, priority: number, ipSetArn: string): Rule {
  const meta = RULE_META[rule.kind];
  const visibility = {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: meta.metric,
  };
  switch (rule.kind) {
    case "ip":
      return {
        Name: meta.name,
        Priority: priority,
        Statement: { IPSetReferenceStatement: { ARN: ipSetArn } },
        Action: matchAction(rule.action),
        VisibilityConfig: visibility,
      };
    case "geo":
      return {
        Name: meta.name,
        Priority: priority,
        // The core validates each entry as an ISO alpha-2 code; `CountryCode` is the
        // SDK's nominal string-union of exactly those codes, so the widen is safe here.
        Statement: { GeoMatchStatement: { CountryCodes: [...rule.countries] as CountryCode[] } },
        Action: matchAction(rule.action),
        VisibilityConfig: visibility,
      };
    case "asn":
      return {
        Name: meta.name,
        Priority: priority,
        Statement: { AsnMatchStatement: { AsnList: [...rule.asns] } },
        Action: matchAction(rule.action),
        VisibilityConfig: visibility,
      };
    case "managed-anonymous":
      // A managed rule group uses OverrideAction (NOT Action); the anonymous-IP list
      // blocks matching requests by default, so `None` leaves that block in force.
      return {
        Name: meta.name,
        Priority: priority,
        Statement: {
          ManagedRuleGroupStatement: {
            VendorName: ANONYMOUS_IP_VENDOR,
            Name: ANONYMOUS_IP_RULE_GROUP,
          },
        },
        OverrideAction: { None: {} },
        VisibilityConfig: visibility,
      };
  }
}

function matchAction(action: "allow" | "block"): Rule["Action"] {
  return action === "allow" ? { Allow: {} } : { Block: {} };
}
