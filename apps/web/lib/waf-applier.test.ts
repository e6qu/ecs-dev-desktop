// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GetIPSetCommand,
  GetWebACLCommand,
  UpdateIPSetCommand,
  UpdateWebACLCommand,
  type GetIPSetCommandOutput,
  type GetWebACLCommandOutput,
  type UpdateIPSetCommandOutput,
  type UpdateWebACLCommandOutput,
} from "@aws-sdk/client-wafv2";
import { compileTrafficFilter, type TrafficFilterPolicy } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RealWafApplier,
  WAF_IP_SET_ID_ENV,
  WAF_IP_SET_NAME_ENV,
  WAF_WEB_ACL_ID_ENV,
  WAF_WEB_ACL_NAME_ENV,
  type Wafv2Port,
} from "./waf-applier";

const IP_SET_ARN = "arn:aws:wafv2:us-east-1:123456789012:global/ipset/edd/abc";

/** A fake WAFv2 port recording the commands it received, so the emitted IPSet/WebACL
 * update SHAPES can be asserted without touching AWS. */
class FakeWafv2 implements Wafv2Port {
  readonly updatedIpSets: UpdateIPSetCommand["input"][] = [];
  readonly updatedWebAcls: UpdateWebACLCommand["input"][] = [];

  getIpSet(_command: GetIPSetCommand): Promise<GetIPSetCommandOutput> {
    return Promise.resolve({
      $metadata: {},
      LockToken: "ip-lock-1",
      IPSet: {
        Name: "edd-ip-set",
        Id: "ip-1",
        ARN: IP_SET_ARN,
        IPAddressVersion: "IPV4",
        Addresses: [],
      },
    });
  }

  updateIpSet(command: UpdateIPSetCommand): Promise<UpdateIPSetCommandOutput> {
    this.updatedIpSets.push(command.input);
    return Promise.resolve({ $metadata: {}, NextLockToken: "ip-lock-2" });
  }

  getWebAcl(_command: GetWebACLCommand): Promise<GetWebACLCommandOutput> {
    return Promise.resolve({
      $metadata: {},
      LockToken: "acl-lock-1",
      WebACL: {
        Name: "edd-web-acl",
        Id: "acl-1",
        ARN: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/edd/xyz",
        DefaultAction: { Allow: {} },
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: "eddWebAcl",
        },
      },
    });
  }

  updateWebAcl(command: UpdateWebACLCommand): Promise<UpdateWebACLCommandOutput> {
    this.updatedWebAcls.push(command.input);
    return Promise.resolve({ $metadata: {}, NextLockToken: "acl-lock-2" });
  }
}

const POLICY: TrafficFilterPolicy = {
  version: 1,
  mode: "allow",
  cidrs: ["203.0.113.0/24"],
  countries: ["US", "DE"],
  asns: [16509],
  presets: [],
  blockAnonymous: true,
};

function setCoordinates(): void {
  process.env[WAF_WEB_ACL_ID_ENV] = "acl-1";
  process.env[WAF_WEB_ACL_NAME_ENV] = "edd-web-acl";
  process.env[WAF_IP_SET_ID_ENV] = "ip-1";
  process.env[WAF_IP_SET_NAME_ENV] = "edd-ip-set";
}

function clearCoordinates(): void {
  for (const name of [
    WAF_WEB_ACL_ID_ENV,
    WAF_WEB_ACL_NAME_ENV,
    WAF_IP_SET_ID_ENV,
    WAF_IP_SET_NAME_ENV,
  ]) {
    Reflect.deleteProperty(process.env, name);
  }
}

describe("RealWafApplier.apply", () => {
  beforeEach(setCoordinates);
  afterEach(clearCoordinates);

  it("writes the ip rule's CIDRs to the IPSet with the returned LockToken", async () => {
    const fake = new FakeWafv2();
    await new RealWafApplier(fake).apply(compileTrafficFilter(POLICY));

    expect(fake.updatedIpSets).toHaveLength(1);
    expect(fake.updatedIpSets[0]).toMatchObject({
      Name: "edd-ip-set",
      Scope: "CLOUDFRONT",
      Id: "ip-1",
      Addresses: ["203.0.113.0/24"],
      LockToken: "ip-lock-1",
    });
  });

  it("emits geo, asn, managed-anonymous, and ip statements on the WebACL with the compiled default action", async () => {
    const fake = new FakeWafv2();
    await new RealWafApplier(fake).apply(compileTrafficFilter(POLICY));

    expect(fake.updatedWebAcls).toHaveLength(1);
    const input = fake.updatedWebAcls[0];
    // allow mode → default BLOCK.
    expect(input.DefaultAction).toEqual({ Block: {} });
    expect(input.LockToken).toBe("acl-lock-1");
    // Preserves the ACL's own VisibilityConfig.
    expect(input.VisibilityConfig?.MetricName).toBe("eddWebAcl");

    const rules = input.Rules ?? [];
    const anon = rules.find((r) => r.Statement?.ManagedRuleGroupStatement !== undefined);
    expect(anon?.Statement?.ManagedRuleGroupStatement).toMatchObject({
      VendorName: "AWS",
      Name: "AWSManagedRulesAnonymousIpList",
    });
    expect(anon?.OverrideAction).toEqual({ None: {} });

    const geo = rules.find((r) => r.Statement?.GeoMatchStatement !== undefined);
    expect(geo?.Statement?.GeoMatchStatement?.CountryCodes).toEqual(["US", "DE"]);
    expect(geo?.Action).toEqual({ Allow: {} }); // allow mode → allow-list rules

    const asn = rules.find((r) => r.Statement?.AsnMatchStatement !== undefined);
    expect(asn?.Statement?.AsnMatchStatement?.AsnList).toEqual([16509]);

    const ip = rules.find((r) => r.Statement?.IPSetReferenceStatement !== undefined);
    expect(ip?.Statement?.IPSetReferenceStatement?.ARN).toBe(IP_SET_ARN);
  });

  it("clears the IPSet addresses when the policy has no ip rule", async () => {
    const fake = new FakeWafv2();
    const noIp: TrafficFilterPolicy = { ...POLICY, cidrs: [] };
    await new RealWafApplier(fake).apply(compileTrafficFilter(noIp));
    expect(fake.updatedIpSets[0].Addresses).toEqual([]);
  });

  it("fails loudly when a required WAF coordinate is missing", async () => {
    clearCoordinates();
    const fake = new FakeWafv2();
    await expect(new RealWafApplier(fake).apply(compileTrafficFilter(POLICY))).rejects.toThrow(
      new RegExp(WAF_WEB_ACL_ID_ENV),
    );
  });
});
