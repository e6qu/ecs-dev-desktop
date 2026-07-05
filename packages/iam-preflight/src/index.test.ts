// SPDX-License-Identifier: AGPL-3.0-or-later
import { IAM_REQUIREMENTS } from "@edd/core";
import { describe, expect, it } from "vitest";

import {
  buildSimulationRequests,
  callerToPrincipalArn,
  decisionsFromEvaluationResults,
  resolveCoordinates,
  resourceArnsForScope,
  type PreflightCoordinates,
} from "./index";

const COORDS: PreflightCoordinates = {
  account: "123456789012",
  region: "us-east-1",
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/edd",
  tableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/edd",
  logGroupArn: "arn:aws:logs:us-east-1:123456789012:log-group:/edd/workspaces:*",
  secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:edd/workspace/preflight-probe",
  taskRoleArns: ["arn:aws:iam::123456789012:role/edd-workspace"],
};

describe("callerToPrincipalArn", () => {
  it("converts an STS assumed-role ARN to the IAM role ARN", () => {
    expect(
      callerToPrincipalArn(
        "arn:aws:sts::123456789012:assumed-role/edd-control-plane/abc123session",
      ),
    ).toBe("arn:aws:iam::123456789012:role/edd-control-plane");
  });

  it("passes a plain role/user ARN through", () => {
    const role = "arn:aws:iam::123456789012:role/edd-control-plane";
    expect(callerToPrincipalArn(role)).toBe(role);
  });

  it("rejects the account root / unparseable / empty", () => {
    expect(callerToPrincipalArn("arn:aws:iam::123456789012:root")).toBeNull();
    expect(callerToPrincipalArn(undefined)).toBeNull();
    expect(callerToPrincipalArn("")).toBeNull();
  });

  it("preserves a non-default partition (aws-us-gov)", () => {
    expect(callerToPrincipalArn("arn:aws-us-gov:sts::123456789012:assumed-role/r/sess")).toBe(
      "arn:aws-us-gov:iam::123456789012:role/r",
    );
  });
});

describe("resolveCoordinates", () => {
  const base = {
    AWS_REGION: "us-east-1",
    ECS_CLUSTER: "edd",
    DYNAMODB_TABLE: "edd",
    ECS_LOG_GROUP_WORKSPACES: "/edd/workspaces",
    ECS_TASK_ROLE_ARN: "arn:aws:iam::123456789012:role/edd-workspace",
  };

  it("builds representative ARNs from coordinates + account", () => {
    const r = resolveCoordinates(base, "123456789012");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.coords.clusterArn).toBe("arn:aws:ecs:us-east-1:123456789012:cluster/edd");
    expect(r.coords.tableArn).toBe("arn:aws:dynamodb:us-east-1:123456789012:table/edd");
    expect(r.coords.logGroupArn).toContain(":log-group:/edd/workspaces:*");
    expect(r.coords.secretArn).toContain(":secret:edd/workspace/");
  });

  it("reports the missing coordinate keys (never throws)", () => {
    const r = resolveCoordinates({ AWS_REGION: "us-east-1" }, "123456789012");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(
      expect.arrayContaining(["ECS_CLUSTER", "DYNAMODB_TABLE", "ECS_LOG_GROUP_WORKSPACES"]),
    );
  });
});

describe("resourceArnsForScope", () => {
  it("any → ['*']", () => {
    expect(resourceArnsForScope("any", COORDS)).toEqual(["*"]);
  });
  it("dynamodb-table → table + index", () => {
    expect(resourceArnsForScope("dynamodb-table", COORDS)).toEqual([
      COORDS.tableArn,
      `${COORDS.tableArn}/index/*`,
    ]);
  });
  it("task-roles → the passable role ARNs", () => {
    expect(resourceArnsForScope("task-roles", COORDS)).toEqual([...COORDS.taskRoleArns]);
  });
  it("cluster → the cluster ARN", () => {
    expect(resourceArnsForScope("cluster", COORDS)).toEqual([COORDS.clusterArn]);
  });
  it("workspace-task-definitions → a representative edd-ws-* task-definition ARN", () => {
    const [arn] = resourceArnsForScope("workspace-task-definitions", COORDS);
    expect(arn).toContain(`:${COORDS.account}:task-definition/edd-ws-`);
  });
});

describe("buildSimulationRequests", () => {
  it("substitutes the ${ECS_CLUSTER_ARN} token into ecs:cluster context", () => {
    const reqs = buildSimulationRequests(IAM_REQUIREMENTS["control-plane"], COORDS);
    const runTask = reqs.find((r) => r.actions.includes("ecs:RunTask"));
    expect(runTask?.context[0]?.ContextKeyName).toBe("ecs:cluster");
    expect(runTask?.context[0]?.ContextKeyValues).toEqual([COORDS.clusterArn]);
  });

  it("keeps literal condition values (ResourceTag, PassedToService) verbatim", () => {
    const reqs = buildSimulationRequests(IAM_REQUIREMENTS["control-plane"], COORDS);
    const reap = reqs.find((r) => r.actions.includes("ec2:DeleteVolume"));
    expect(reap?.context[0]?.ContextKeyValues).toEqual(["true"]);
    const pass = reqs.find((r) => r.actions.includes("iam:PassRole"));
    expect(pass?.resourceArns).toEqual([...COORDS.taskRoleArns]);
    expect(pass?.context[0]?.ContextKeyValues).toEqual(["ecs-tasks.amazonaws.com"]);
  });
});

describe("decisionsFromEvaluationResults", () => {
  it("maps allowed/implicitDeny → boolean and skips nameless results", () => {
    expect(
      decisionsFromEvaluationResults([
        { EvalActionName: "ecs:RunTask", EvalDecision: "allowed" },
        { EvalActionName: "ec2:DeleteVolume", EvalDecision: "implicitDeny" },
        { EvalDecision: "allowed" },
      ]),
    ).toEqual([
      { action: "ecs:RunTask", allowed: true },
      { action: "ec2:DeleteVolume", allowed: false },
    ]);
  });

  it("does NOT report 'allowed' when MissingContextValues is present (provisional → fail-closed)", () => {
    // A provisional 'allowed' (AWS couldn't evaluate a condition for lack of context)
    // must not read as a definitive allow — the preflight would otherwise report green
    // while a condition gate is actually unevaluated.
    expect(
      decisionsFromEvaluationResults([
        {
          EvalActionName: "ecs:RunTask",
          EvalDecision: "allowed",
          MissingContextValues: ["ecs:cluster"],
        },
      ]),
    ).toEqual([{ action: "ecs:RunTask", allowed: false }]);
  });
});
