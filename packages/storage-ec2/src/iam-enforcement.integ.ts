// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import { CreateVolumeCommand, DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  IAMClient,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the AWS SDK at whatever AWS coordinates the environment supplies (the sockerless
// sim in the Tier-2 harness, or real AWS in e2e-aws) — §6.9, coordinates not targets.
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const REGION = process.env.AWS_REGION; // set just above, so a string
// A region the region-locked policy below does NOT permit (to force the condition to fail).
const OTHER_REGION = REGION === "us-west-2" ? "us-east-1" : "us-west-2";
const ENDPOINT = process.env.AWS_ENDPOINT_URL;
const POLICY_NAME = "edd-test-inline-policy";

// The ambient (admin) identity, used only to PROVISION the restricted principals below.
const iam = new IAMClient({ region: REGION, endpoint: ENDPOINT });

const policyDoc = (statement: Record<string, unknown>): string =>
  JSON.stringify({ Version: "2012-10-17", Statement: [statement] });

interface RestrictedPrincipal {
  /** An EC2 client that authenticates AS the restricted principal, targeting `region`. */
  ec2(region: string): EC2Client;
  teardown(): Promise<void>;
}

// Bring up a restricted IAM principal via STANDARD IAM APIs (CreateUser → PutUserPolicy →
// CreateAccessKey) — the same surface a real-AWS deployment provisions out of band — bound to
// `policyDocument`, and hand back a factory for region-scoped EC2 clients + a teardown.
async function provisionPrincipal(policyDocument: string): Promise<RestrictedPrincipal> {
  const userName = `edd-iam-enforce-${randomBytes(4).toString("hex")}`;
  await iam.send(new CreateUserCommand({ UserName: userName }));
  await iam.send(
    new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: POLICY_NAME,
      PolicyDocument: policyDocument,
    }),
  );
  const created = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
  const accessKeyId = created.AccessKey?.AccessKeyId;
  const secretAccessKey = created.AccessKey?.SecretAccessKey;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("CreateAccessKey did not return a usable access key");
  }
  return {
    ec2: (region) =>
      new EC2Client({
        region,
        endpoint: ENDPOINT,
        credentials: { accessKeyId, secretAccessKey },
        maxAttempts: 1, // a denial is terminal — don't retry it as a transient error
      }),
    teardown: async () => {
      // Best-effort (the access key must go before the user). The sim is ephemeral, but a
      // real-AWS run must not leak the principal.
      await iam
        .send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }))
        .catch(() => undefined);
      await iam
        .send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: POLICY_NAME }))
        .catch(() => undefined);
      await iam.send(new DeleteUserCommand({ UserName: userName })).catch(() => undefined);
    },
  };
}

// Proves least-privilege IAM is enforced at CALL time — a real denied call, not merely that
// the policy text denies (which the SimulatePrincipalPolicy preflight in @edd/iam-preflight
// already covers). Requires a target that enforces IAM on the SigV4 caller's policy
// (sockerless gained call-time enforcement in #659 / issue #657, and the full condition
// evaluator in #660; real AWS always has). Standard IAM + EC2 APIs only — the same code/test
// targets the sim or real cloud by coordinates alone.

describe("least-privilege IAM enforcement — action level", () => {
  let principal: RestrictedPrincipal;
  // A policy granting ec2:DescribeVolumes and NOTHING ELSE.
  beforeAll(async () => {
    principal = await provisionPrincipal(
      policyDoc({ Effect: "Allow", Action: "ec2:DescribeVolumes", Resource: "*" }),
    );
  });
  afterAll(() => principal.teardown());

  it("ALLOWS an action the policy grants (ec2:DescribeVolumes)", async () => {
    // Positive control: the gate must not blanket-deny a registered principal.
    await expect(principal.ec2(REGION).send(new DescribeVolumesCommand({}))).resolves.toBeDefined();
  });

  it("DENIES an action the policy omits (ec2:CreateVolume) with UnauthorizedOperation", async () => {
    // Negative control: the ungranted action is rejected at call time — least-privilege blocks.
    await expect(
      principal
        .ec2(REGION)
        .send(new CreateVolumeCommand({ AvailabilityZone: `${REGION}a`, Size: 1 })),
    ).rejects.toMatchObject({ name: "UnauthorizedOperation" });
  });
});

describe("least-privilege IAM enforcement — condition keys", () => {
  let principal: RestrictedPrincipal;
  // A region-locked policy: ec2:CreateVolume is granted ONLY when aws:RequestedRegion matches
  // REGION — so the SAME action is allowed in REGION and denied elsewhere, proving the gate
  // evaluates the policy's Condition against request context, not just the action.
  beforeAll(async () => {
    principal = await provisionPrincipal(
      policyDoc({
        Effect: "Allow",
        Action: "ec2:CreateVolume",
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": REGION } },
      }),
    );
  });
  afterAll(() => principal.teardown());

  it("ALLOWS CreateVolume when the aws:RequestedRegion condition is met", async () => {
    await expect(
      principal
        .ec2(REGION)
        .send(new CreateVolumeCommand({ AvailabilityZone: `${REGION}a`, Size: 1 })),
    ).resolves.toBeDefined();
  });

  it("DENIES CreateVolume when the aws:RequestedRegion condition is NOT met", async () => {
    await expect(
      principal
        .ec2(OTHER_REGION)
        .send(new CreateVolumeCommand({ AvailabilityZone: `${OTHER_REGION}a`, Size: 1 })),
    ).rejects.toMatchObject({ name: "UnauthorizedOperation" });
  });
});
