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
const ENDPOINT = process.env.AWS_ENDPOINT_URL;
// The ambient (admin) identity used only to PROVISION the restricted principal below.
const ADMIN_CONFIG = { region: REGION, endpoint: ENDPOINT };

const USER_NAME = `edd-iam-enforce-${randomBytes(4).toString("hex")}`;
const POLICY_NAME = "describe-volumes-only";
// A least-privilege inline policy: it grants ec2:DescribeVolumes and NOTHING ELSE — so
// DescribeVolumes must be allowed (positive control) while CreateVolume, which it does not
// grant, must be denied (negative control). This proves the gate evaluates policy
// SELECTIVELY, not as a blanket allow or blanket deny.
const DESCRIBE_ONLY_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "ec2:DescribeVolumes", Resource: "*" }],
});

const iam = new IAMClient(ADMIN_CONFIG);
let restrictedEc2: EC2Client;
let createdAccessKeyId: string | undefined;

// Proves least-privilege IAM is enforced at CALL time — a real denied call, not merely that
// the policy text denies (which the SimulatePrincipalPolicy preflight in @edd/iam-preflight
// already covers). Requires a target that enforces IAM on the SigV4 caller's policy
// (sockerless gained this in #659 for issue #657; real AWS always has). Standard IAM + EC2
// APIs only — the same code/test targets the sim or real cloud by coordinates alone.
describe("least-privilege IAM is enforced at call time", () => {
  beforeAll(async () => {
    // Bring up the restricted principal via STANDARD IAM APIs (CreateUser → PutUserPolicy →
    // CreateAccessKey) — the same surface a real-AWS deployment provisions out of band.
    await iam.send(new CreateUserCommand({ UserName: USER_NAME }));
    await iam.send(
      new PutUserPolicyCommand({
        UserName: USER_NAME,
        PolicyName: POLICY_NAME,
        PolicyDocument: DESCRIBE_ONLY_POLICY,
      }),
    );
    const created = await iam.send(new CreateAccessKeyCommand({ UserName: USER_NAME }));
    const accessKeyId = created.AccessKey?.AccessKeyId;
    const secretAccessKey = created.AccessKey?.SecretAccessKey;
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw new Error("CreateAccessKey did not return a usable access key");
    }
    createdAccessKeyId = accessKeyId;
    restrictedEc2 = new EC2Client({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1, // a denial is terminal — don't retry it as a transient error
    });
  });

  afterAll(async () => {
    // Best-effort teardown (the access key must go before the user). The sim is ephemeral,
    // but a real-AWS run must not leak the principal.
    if (createdAccessKeyId !== undefined) {
      await iam
        .send(new DeleteAccessKeyCommand({ UserName: USER_NAME, AccessKeyId: createdAccessKeyId }))
        .catch(() => undefined);
    }
    await iam
      .send(new DeleteUserPolicyCommand({ UserName: USER_NAME, PolicyName: POLICY_NAME }))
      .catch(() => undefined);
    await iam.send(new DeleteUserCommand({ UserName: USER_NAME })).catch(() => undefined);
  });

  it("ALLOWS an action the policy grants (ec2:DescribeVolumes)", async () => {
    // Positive control: the gate must not blanket-deny a registered principal — the granted
    // action goes through.
    await expect(restrictedEc2.send(new DescribeVolumesCommand({}))).resolves.toBeDefined();
  });

  it("DENIES an action the policy omits (ec2:CreateVolume) with UnauthorizedOperation", async () => {
    // Negative control: the ungranted action is rejected at call time with EC2's denied-call
    // error code — least-privilege actually blocks, not just evaluates.
    await expect(
      restrictedEc2.send(new CreateVolumeCommand({ AvailabilityZone: `${REGION}a`, Size: 1 })),
    ).rejects.toMatchObject({ name: "UnauthorizedOperation" });
  });
});
