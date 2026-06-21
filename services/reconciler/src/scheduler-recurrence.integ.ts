// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import {
  CreateClusterCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  type FlexibleTimeWindowMode,
  GetScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

/**
 * Integration: the PRODUCTION reconciler cron model — a recurring EventBridge
 * Scheduler `rate(...)` schedule — actually FIRES its ECS RunTask target repeatedly
 * against the sim. Terraform (`reconciler.tf`) provisions this schedule with
 * `rate(5 minutes)` and `terraform-sim` proves it is CREATED; the container e2e proves a
 * single `at(...)` one-shot drives the reconciler. This closes the remaining gap: that a
 * *recurring* schedule re-arms and fires on its cadence (not just once).
 *
 * Detection is via CloudTrail `LookupEvents` (the scheduler records each RunTask fire,
 * even if the target RunTask itself fails on the fake subnet — we assert the FIRE, not a
 * launched container; a container launch is the e2e tier's job). The lookup is SCOPED to
 * this cluster's `ResourceName` (one attribute, as real CloudTrail allows) so the count is
 * immune to the other integ suites hammering the shared sim concurrently — without the
 * scope, a `MaxResults` page fills with their events and buries this cluster's later fire.
 * Uses `rate(1 minute)`, the smallest AWS rate unit, so two fires fit the test window.
 */
const RUN = String(Math.floor(Date.now() / 1000) % 1_000_000);
const CLUSTER = `edd-cron-recur-${RUN}`;
const SCHEDULE = `edd-cron-recur-${RUN}`;
const FROM_SUBNET = "subnet-cron-recur"; // never created — the fire is recorded regardless

describe("recurring rate() schedule fires its ECS target repeatedly (sockerless AWS sim)", () => {
  const ecs = new ECSClient({});
  const scheduler = new SchedulerClient({});
  const cloudtrail = new CloudTrailClient({});

  let clusterArn: string;

  beforeAll(async () => {
    const cluster = await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
    clusterArn = cluster.cluster?.clusterArn ?? "";
    const td = await ecs.send(
      new RegisterTaskDefinitionCommand({
        family: `edd-cron-recur-${RUN}`,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        cpu: "256",
        memory: "512",
        containerDefinitions: [{ name: "x", image: "busybox", essential: true }],
      }),
    );

    await scheduler.send(
      new CreateScheduleCommand({
        Name: SCHEDULE,
        GroupName: "default",
        // The production model (reconciler.tf defaults to rate(5 minutes)); rate(1 minute)
        // is the same recurring class at the smallest unit so two fires fit the window.
        ScheduleExpression: "rate(1 minute)",
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" as FlexibleTimeWindowMode },
        // DELETE-on-completion would remove a ONE-SHOT after it fires; a recurring schedule
        // must survive (re-arm) — asserted below.
        ActionAfterCompletion: "DELETE",
        Target: {
          Arn: clusterArn,
          RoleArn: "arn:aws:iam::000000000000:role/scheduler",
          EcsParameters: {
            TaskDefinitionArn: td.taskDefinition?.taskDefinitionArn,
            TaskCount: 1,
            LaunchType: "FARGATE",
            NetworkConfiguration: {
              awsvpcConfiguration: { Subnets: [FROM_SUBNET], AssignPublicIp: "ENABLED" },
            },
          },
        },
      }),
    );
  });

  afterAll(async () => {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name: SCHEDULE, GroupName: "default" }));
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
  });

  it("round-trips the recurring rate() expression", async () => {
    const got = await scheduler.send(
      new GetScheduleCommand({ Name: SCHEDULE, GroupName: "default" }),
    );
    expect(got.ScheduleExpression).toBe("rate(1 minute)");
  });

  it(
    "fires RunTask repeatedly and re-arms (not deleted like a one-shot)",
    { timeout: 180_000 },
    async () => {
      // First fire lands at creation + 1 minute, the next a minute later; poll CloudTrail
      // until at least two fires for THIS cluster are recorded (recurrence).
      const deadline = Date.now() + 170_000;
      let fires = 0;
      while (Date.now() < deadline) {
        // Scope to THIS cluster (the fire records ResourceName = the cluster's short
        // name); a single LookupAttribute, as real CloudTrail LookupEvents permits.
        const out = await cloudtrail.send(
          new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: CLUSTER }],
            MaxResults: 50,
          }),
        );
        fires = (out.Events ?? []).filter((e) => e.EventName === "RunTask").length;
        if (fires >= 2) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
      expect(fires, "recurring schedule must fire RunTask at least twice").toBeGreaterThanOrEqual(
        2,
      );

      // It fired AND survives — a one-shot at() with ActionAfterCompletion=DELETE would be
      // gone by now; a recurring rate() re-arms for its next fire.
      const after = await scheduler.send(
        new GetScheduleCommand({ Name: SCHEDULE, GroupName: "default" }),
      );
      expect(after.ScheduleExpression).toBe("rate(1 minute)");
    },
  );
});
