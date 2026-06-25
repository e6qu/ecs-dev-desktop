// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared Tier-2 integration-test support: provision a restricted IAM principal via STANDARD IAM
// APIs (the same surface a real-AWS deploy provisions out of band), so call-time least-privilege
// enforcement can be proven against the sockerless sim OR real AWS by coordinates alone (§6.9).
// Used by the per-service IAM-enforcement integ tests (storage-ec2 EC2, compute-ecs ECS).
import { randomBytes } from "node:crypto";

import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  type IAMClient,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";

const POLICY_NAME = "edd-test-inline-policy";

export interface RestrictedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Best-effort teardown (access key before the user). The sim is ephemeral, but a real-AWS run
   * must not leak the principal. An arrow-property (not a method) so it stays bound when detached. */
  readonly teardown: () => Promise<void>;
}

/** A single-statement inline IAM policy document (`{Version, Statement: [statement]}`). */
export function inlinePolicy(statement: Record<string, unknown>): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: [statement] });
}

/**
 * Create a restricted IAM user bound to `policyDocument` (CreateUser → PutUserPolicy →
 * CreateAccessKey) and return its access key + a teardown. `iam` is an ambient (admin) client used
 * only to provision the principal.
 */
export async function provisionRestrictedCredentials(
  iam: IAMClient,
  policyDocument: string,
): Promise<RestrictedCredentials> {
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
    accessKeyId,
    secretAccessKey,
    teardown: async () => {
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
