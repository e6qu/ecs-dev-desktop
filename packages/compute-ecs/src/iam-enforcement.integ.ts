// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import {
  CreateClusterCommand,
  DeleteClusterCommand,
  ECSClient,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import { IAMClient } from "@aws-sdk/client-iam";
import { inlinePolicy, provisionRestrictedCredentials } from "@edd/aws-itest-support";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the AWS SDK at whatever AWS coordinates the environment supplies (the sockerless sim in the
// Tier-2 harness, or real AWS in e2e-aws) — §6.9, coordinates not targets.
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const REGION = process.env.AWS_REGION;
const ENDPOINT = process.env.AWS_ENDPOINT_URL;

const iam = new IAMClient({ region: REGION, endpoint: ENDPOINT });
const adminEcs = new ECSClient({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// Proves the ECS service-scoped condition key `ecs:cluster` is enforced at CALL time — the second
// half of sockerless issue #661 (resource/service condition keys), now populated by #662. Our
// least-privilege design scopes the workspace ECS task grants (RunTask/StopTask/ListTasks/…) to one
// cluster via StringEquals{ecs:cluster: <arn>} (see core `iam-requirements` + terraform `iam.tf`), so
// the SAME action is allowed on the granted cluster and denied on any other — proving the gate
// resolves the target's cluster into request context, not just the action. Standard IAM + ECS APIs
// only; the same test hits the sim or real cloud by coordinates alone (§6.9).
describe("least-privilege IAM enforcement — ecs:cluster service condition key", () => {
  let teardown: (() => Promise<void>) | undefined;
  let granted: ECSClient;
  let grantedClusterArn = "";
  let otherClusterArn = "";

  beforeAll(async () => {
    const suffix = randomBytes(4).toString("hex");
    const a = await adminEcs.send(
      new CreateClusterCommand({ clusterName: `edd-iam-grant-${suffix}` }),
    );
    const b = await adminEcs.send(
      new CreateClusterCommand({ clusterName: `edd-iam-other-${suffix}` }),
    );
    grantedClusterArn = a.cluster?.clusterArn ?? "";
    otherClusterArn = b.cluster?.clusterArn ?? "";
    expect(grantedClusterArn).not.toBe("");
    expect(otherClusterArn).not.toBe("");

    const creds = await provisionRestrictedCredentials(
      iam,
      inlinePolicy({
        Effect: "Allow",
        Action: "ecs:ListTasks",
        Resource: "*",
        Condition: { StringEquals: { "ecs:cluster": grantedClusterArn } },
      }),
    );
    teardown = creds.teardown;
    granted = new ECSClient({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      maxAttempts: 1, // a denial is terminal — don't retry it as a transient error
    });
  });

  afterAll(async () => {
    if (teardown !== undefined) await teardown();
    for (const arn of [grantedClusterArn, otherClusterArn]) {
      if (arn !== "") {
        await adminEcs.send(new DeleteClusterCommand({ cluster: arn })).catch(() => undefined);
      }
    }
  });

  it("ALLOWS ListTasks on the granted cluster (ecs:cluster condition met)", async () => {
    await expect(
      granted.send(new ListTasksCommand({ cluster: grantedClusterArn })),
    ).resolves.toBeDefined();
  });

  it("DENIES ListTasks on a different cluster (ecs:cluster condition not met)", async () => {
    await expect(
      granted.send(new ListTasksCommand({ cluster: otherClusterArn })),
    ).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});
