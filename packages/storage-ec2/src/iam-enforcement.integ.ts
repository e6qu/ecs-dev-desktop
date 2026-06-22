// SPDX-License-Identifier: AGPL-3.0-or-later
import { CreateVolumeCommand, EC2Client } from "@aws-sdk/client-ec2";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { describe, expect, it } from "vitest";

// Point the AWS SDK at whatever AWS coordinates the environment supplies (the sockerless
// sim in the Tier-2 harness, or real AWS in e2e-aws) — §6.9, coordinates not targets.
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;

// Coordinates for a RESTRICTED principal — an access key bound (out of band, by the
// deployment) to a policy that does NOT grant `ec2:CreateVolume`, modelling the platform's
// zero-permission `workspace` task role (infra/terraform/.../iam.tf). Built once (so it's a
// concrete object or `undefined` — no later null-assertions). When absent we cannot exercise
// call-time enforcement, so the suite SKIPS — it never falls back to the ambient/unrestricted
// credentials (that would assert nothing).
const keyId = process.env.EDD_IAM_DENIED_ACCESS_KEY_ID;
const secret = process.env.EDD_IAM_DENIED_SECRET_ACCESS_KEY;
const deniedCredentials =
  keyId !== undefined && secret !== undefined
    ? { accessKeyId: keyId, secretAccessKey: secret }
    : undefined;

// Proves least-privilege IAM is enforced at CALL time (not merely that the policy text
// denies — that's covered by the SimulatePrincipalPolicy preflight in @edd/iam-preflight).
// The sockerless sim does not yet enforce IAM on service calls (it authorizes every request
// regardless of policy) — filed as e6qu/sockerless#657 — so the restricted-principal
// coordinates above cannot be supplied against the sim yet and this suite skips there. It
// runs UNCHANGED once the sim enforces, and against real AWS in the e2e-aws tier.
describe.skipIf(deniedCredentials === undefined)(
  "least-privilege IAM is enforced at call time",
  () => {
    it("denies CreateVolume to a principal without ec2:CreateVolume (UnauthorizedOperation)", async () => {
      const ec2 = new EC2Client({
        region: process.env.AWS_REGION,
        endpoint: process.env.AWS_ENDPOINT_URL,
        credentials: deniedCredentials,
        maxAttempts: 1, // a denial is terminal — don't retry it as a transient error
      });

      await expect(
        ec2.send(
          new CreateVolumeCommand({
            AvailabilityZone: `${process.env.AWS_REGION ?? DEFAULT_AWS_REGION}a`,
            Size: 1,
          }),
        ),
      ).rejects.toMatchObject({ name: "UnauthorizedOperation" });
    });
  },
);
