// SPDX-License-Identifier: AGPL-3.0-or-later
// Drift gate: the terraform task-role policies MUST grant ⊇ the IAM_REQUIREMENTS
// manifest the app self-checks against. If the app starts needing an action, this
// fails until iam.tf grants it (and vice-versa the manifest must list what the app
// uses) — so the IaC and the runtime self-check can never silently diverge.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IAM_REQUIREMENTS, requiredActions, type IamComponent } from "@edd/core";
import { describe, expect, it } from "vitest";

const IAM_TF = fileURLToPath(
  new URL("../../../infra/terraform/modules/ecs-dev-desktop/iam.tf", import.meta.url),
);

/** terraform `data "aws_iam_policy_document"` name backing each component's role. */
const POLICY_DOC: Record<IamComponent, string> = {
  "control-plane": "control_plane",
  reconciler: "reconciler",
};

/** Collect every action string granted in a named policy-document block. */
function grantedActions(tf: string, docName: string): Set<string> {
  const start = tf.indexOf(`data "aws_iam_policy_document" "${docName}"`);
  if (start < 0) throw new Error(`policy document ${docName} not found in iam.tf`);
  // Each policy document is immediately followed by its `resource "aws_iam_role"`.
  const end = tf.indexOf('\nresource "', start);
  const block = tf.slice(start, end < 0 ? undefined : end);

  const granted = new Set<string>();
  // Only the `actions = [ ... ]` arrays — not resources/conditions/sids.
  for (const arr of block.matchAll(/actions\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const tok of arr[1].matchAll(/"([^"]+)"/g)) granted.add(tok[1]);
  }
  return granted;
}

describe("IAM manifest ⊆ terraform-granted actions (drift gate)", () => {
  const tf = readFileSync(IAM_TF, "utf8");

  for (const component of Object.keys(IAM_REQUIREMENTS) as IamComponent[]) {
    it(`${component}: every required action is granted by its role policy`, () => {
      const granted = grantedActions(tf, POLICY_DOC[component]);
      const ungranted = requiredActions(component).filter((a) => !granted.has(a));
      expect(
        ungranted,
        `actions in the manifest but not granted in iam.tf: ${ungranted.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("the parser actually found a non-trivial policy (guards against a silent empty match)", () => {
    expect(grantedActions(tf, "control_plane").size).toBeGreaterThan(10);
  });
});
