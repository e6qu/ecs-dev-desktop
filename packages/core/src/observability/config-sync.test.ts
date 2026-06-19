// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { evaluateConfigSync, type ConfigSyncInput } from "./config-sync";

const REAL_ENV: ConfigSyncInput["env"] = {
  COMPUTE_PROVIDER: "ecs",
  ECS_CLUSTER: "edd",
  ECS_SUBNETS: "subnet-a,subnet-b",
  ECS_SECURITY_GROUPS: "sg-1",
  ECS_EBS_ROLE_ARN: "arn:ebs",
  ECS_EXECUTION_ROLE_ARN: "arn:exec",
  ECS_TASK_ROLE_ARN: "arn:task",
  CONTROL_PLANE_URL: "https://app.example.com",
  AUDIT_PROVIDER: "cloudtrail",
  LOG_PROVIDER: "cloudwatch",
  EDD_APP_NAME: "edd",
  ECS_LOG_GROUP_WORKSPACES: "/edd/workspaces",
};

describe("evaluateConfigSync", () => {
  it("reports in-sync for a fully-configured real deployment with healthy deps", () => {
    const report = evaluateConfigSync({ env: REAL_ENV, dynamodb: "ok", compute: "ok" });
    expect(report.inSync).toBe(true);
    expect(report.checks.find((c) => c.name === "compute-provider")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "ecs-coordinates")?.status).toBe("ok");
  });

  it("flags missing required coordinates as drift", () => {
    const env = { ...REAL_ENV, ECS_EXECUTION_ROLE_ARN: undefined, ECS_TASK_ROLE_ARN: "" };
    const report = evaluateConfigSync({ env, dynamodb: "ok", compute: "ok" });
    expect(report.inSync).toBe(false);
    const coords = report.checks.find((c) => c.name === "ecs-coordinates");
    expect(coords?.status).toBe("drift");
    expect(coords?.detail).toContain("ECS_EXECUTION_ROLE_ARN");
    expect(coords?.detail).toContain("ECS_TASK_ROLE_ARN");
  });

  it("flags a down dependency as drift", () => {
    const report = evaluateConfigSync({ env: REAL_ENV, dynamodb: "down", compute: "ok" });
    expect(report.inSync).toBe(false);
    expect(report.checks.find((c) => c.name === "dynamodb")?.status).toBe("drift");
  });

  it("treats fakes (dev) as unknown, not drift, and skips ECS coordinate checks", () => {
    const report = evaluateConfigSync({
      env: { COMPUTE_PROVIDER: "fake" },
      dynamodb: "ok",
      compute: "unknown",
    });
    expect(report.checks.find((c) => c.name === "compute-provider")?.status).toBe("unknown");
    expect(report.checks.some((c) => c.name === "ecs-coordinates")).toBe(false);
    // unknown deps don't make it "out of sync"
    expect(report.inSync).toBe(true);
  });

  it("adds an IAM-permissions check from the preflight signal; unknown never breaks sync", () => {
    const present = evaluateConfigSync({
      env: REAL_ENV,
      dynamodb: "ok",
      compute: "ok",
      iam: { kind: "checked", decisions: [{ action: "ecs:RunTask", allowed: true }] },
    });
    expect(present.checks.some((c) => c.name === "iam-permissions:control-plane")).toBe(true);

    const unknown = evaluateConfigSync({
      env: REAL_ENV,
      dynamodb: "ok",
      compute: "ok",
      iam: { kind: "unavailable", reason: "no caller identity" },
    });
    const iamCheck = unknown.checks.find((c) => c.name === "iam-permissions:control-plane");
    expect(iamCheck?.status).toBe("unknown");
    expect(unknown.inSync).toBe(true);
  });

  it("omits the IAM check when no preflight signal is supplied", () => {
    const report = evaluateConfigSync({ env: REAL_ENV, dynamodb: "ok", compute: "ok" });
    expect(report.checks.some((c) => c.name.startsWith("iam-permissions"))).toBe(false);
  });

  it("passes the resolved IAM identity through to the report", () => {
    const identity = {
      account: "123456789012",
      callerArn: "arn:aws:sts::123456789012:assumed-role/edd-control-plane/sess",
      principalArn: "arn:aws:iam::123456789012:role/edd-control-plane",
    };
    const report = evaluateConfigSync({
      env: REAL_ENV,
      dynamodb: "ok",
      compute: "ok",
      iamIdentity: identity,
    });
    expect(report.identity).toEqual(identity);
  });
});
