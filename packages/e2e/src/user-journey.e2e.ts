// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand, DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { workspace, workspaceInspection, type WorkspaceDetailDto } from "@edd/api-contracts";
import { aws, dynamodb } from "@edd/config";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeBaseImageEntity } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  awsSimClientConfig,
  configureAwsSimEnv,
  createVpcWithEgress,
  e2eEbsRoleArn,
  e2eWorkspaceImage,
  required,
  sleep,
} from "./aws-sim";
import { hostReachableTarget } from "./docker-host";
import { devHeaders, startWebApp, type WebApp } from "./web-app";

/**
 * LIVE user journey — the full product flow through the REAL API surface with
 * NO fake compute/storage:
 *
 *   production-built `apps/web` (COMPUTE_PROVIDER=ecs) → EcsComputeProvider +
 *   Ec2StorageProvider → container-mode sockerless AWS sim running the real
 *   golden workspace image (managed EBS, awsvpc ENI).
 *
 * Steps: create (real ECS task launches) → admin Inspect shows real bindings →
 * the IN-WORKSPACE idle-agent posts real HMAC heartbeats back to the control
 * plane (lastActivity advances) → register an account SSH key via the API →
 * point-in-time snapshot → stop (scale to zero; the sim task really stops) →
 * wake-on-connect (a NEW task hydrates from the snapshot) → delete.
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const TABLE = `edd-user-journey-${RUN_ID}`;
const CLUSTER = `edd-journey-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/journey-${RUN_ID}`;
const WORKSPACE_IMAGE = e2eWorkspaceImage();
const EBS_ROLE = e2eEbsRoleArn();
const AGENT_SECRET = "e".repeat(64);
const HEARTBEAT_INTERVAL_S = 5;
const OWNER = "journey-user";

const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");
const USER_KEY = join(SSH_CA_DIR, `journey-${RUN_ID}`);

const SIM = awsSimClientConfig();

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe(
  "LIVE user journey through the real API on container-mode sim",
  { timeout: 600_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    let web: WebApp;
    let wsId = "";
    let firstTaskId = "";
    let firstVolumeId = "";
    let activityAfterCreate = "";

    async function api(path: string, init?: RequestInit): Promise<Response> {
      return fetch(`${web.baseUrl}/api${path}`, { headers: devHeaders(OWNER, "member"), ...init });
    }

    /** Full persisted detail via the admin Inspect route. */
    async function inspect(): Promise<WorkspaceDetailDto> {
      const res = await fetch(`${web.baseUrl}/api/admin/workspaces/${wsId}`, {
        headers: devHeaders("root", "admin"),
      });
      expect(res.status).toBe(200);
      return workspaceInspection.parse(await res.json()).workspace;
    }

    async function simTaskStatus(taskArn: string): Promise<string> {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
      return required(out.tasks?.[0]?.lastStatus, "task lastStatus");
    }

    /** Poll the sim until the task reaches `status` (fail loudly on timeout). */
    async function awaitTaskStatus(taskArn: string, status: "RUNNING" | "STOPPED"): Promise<void> {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const current = await simTaskStatus(taskArn);
        if (current === status) return;
        if (status === "RUNNING" && current === "STOPPED") {
          throw new Error(`task ${taskArn} stopped before reaching RUNNING`);
        }
        if (Date.now() > deadline) {
          throw new Error(`task ${taskArn} never reached ${status} (last: ${current})`);
        }
        await sleep(2_000);
      }
    }

    /** Assert an API response status, surfacing the body on mismatch. */
    async function expectStatus(res: Response, status: number): Promise<Response> {
      if (res.status !== status) {
        throw new Error(
          `expected ${String(status)}, got ${String(res.status)}: ${await res.text()}`,
        );
      }
      return res;
    }

    beforeAll(async () => {
      const dynamo = createDynamoClient();
      await dropTable(dynamo, TABLE);
      await ensureTable(dynamo, TABLE);
      await new CatalogService({
        baseImages: makeBaseImageEntity(dynamo, TABLE),
        clock: systemClock,
      }).create({ name: "Golden e2e", image: baseImage(WORKSPACE_IMAGE) });

      const vpc = await createVpcWithEgress(ec2, {
        vpcCidr: "10.72.0.0/16",
        subnetCidr: "10.72.1.0/24",
        securityGroupName: `journey-sg-${RUN_ID}`,
      });
      await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
      await new CloudWatchLogsClient(SIM).send(
        new CreateLogGroupCommand({ logGroupName: LOG_GROUP }),
      );

      // The workspace task's idle-agent must reach the control plane from inside
      // the sim task container. On dockerd (CI) the sim rewrites
      // host.docker.internal in task env (sockerless #521, reconciler-container
      // pattern); on runtimes without host-gateway the containers resolve
      // host.containers.internal natively — probe which applies here.
      const hostAlias = hostReachableTarget(WORKSPACE_IMAGE).host;
      web = await startWebApp((port) => ({
        DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? dynamodb.endpoint,
        DYNAMODB_TABLE: TABLE,
        COMPUTE_PROVIDER: "ecs",
        AWS_ENDPOINT_URL: aws.endpoint,
        AWS_REGION: SIM.region,
        AWS_ACCESS_KEY_ID: SIM.credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: SIM.credentials.secretAccessKey,
        ECS_CLUSTER: CLUSTER,
        ECS_SUBNETS: vpc.subnetId,
        ECS_SECURITY_GROUPS: vpc.securityGroupId,
        ECS_EBS_ROLE_ARN: EBS_ROLE,
        ECS_ASSIGN_PUBLIC_IP: "1",
        ECS_LOG_GROUP_WORKSPACES: LOG_GROUP,
        CONTROL_PLANE_URL: `http://${hostAlias}:${String(port)}`,
        EDD_AGENT_SECRET: AGENT_SECRET,
        EDD_HEARTBEAT_INTERVAL_S: String(HEARTBEAT_INTERVAL_S),
      }));
    });

    afterAll(async () => {
      web.stop();
      await dropTable(createDynamoClient(), TABLE);
      for (const f of [USER_KEY, `${USER_KEY}.pub`]) rmSync(f, { force: true });
    });

    it("creates a workspace: a real golden-image ECS task with managed EBS", async () => {
      const res = await api("/workspaces", {
        method: "POST",
        body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
      });
      expect(res.status).toBe(201);
      const ws = workspace.parse(await res.json());
      expect(ws.state).toBe("running");
      wsId = ws.id;

      const detail = await inspect();
      firstTaskId = required(detail.taskId, "taskId");
      firstVolumeId = required(detail.volumeId, "volumeId");
      activityAfterCreate = detail.lastActivity;
      // Real awsvpc ENI address from the journey subnet.
      expect(detail.sshHost).toMatch(/^10\.72\.1\.\d+$/);
      // create() returns once the managed volume is attached; RUNNING follows.
      await awaitTaskStatus(firstTaskId, "RUNNING");
    });

    it("the in-workspace idle-agent posts real heartbeats: lastActivity advances", async () => {
      // The golden image's idle-agent beats every HEARTBEAT_INTERVAL_S with its
      // injected HMAC token. Nothing else touches lastActivity here, so any
      // advance proves: agent env injection → curl from the task container →
      // machine-auth verification → markActivity persisted.
      const deadline = Date.now() + 90_000;
      let advanced = false;
      while (Date.now() < deadline) {
        const detail = await inspect();
        if (detail.lastActivity > activityAfterCreate) {
          advanced = true;
          break;
        }
        await sleep(2_000);
      }
      expect(advanced, "idle-agent heartbeat never advanced lastActivity").toBe(true);
    });

    it("registers an account SSH key the workspace authorizes by ownership", async () => {
      mkdirSync(SSH_CA_DIR, { recursive: true });
      const keygen = run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", USER_KEY]);
      expect(keygen.status, keygen.stderr).toBe(0);
      const publicKey = readFileSync(`${USER_KEY}.pub`, "utf8").trim();
      const res = await api("/ssh-keys", { method: "POST", body: JSON.stringify({ publicKey }) });
      expect(res.status).toBe(201);
      const { key } = (await res.json()) as { key: { fingerprint: string; keyType: string } };
      expect(key.keyType).toBe("ssh-ed25519");
      expect(key.fingerprint).toMatch(/^SHA256:/);

      // It is listed for the owner — the gateway/workspace authorize SSH by this.
      const listed = (await (await api("/ssh-keys")).json()) as { keys: { fingerprint: string }[] };
      expect(listed.keys.some((k) => k.fingerprint === key.fingerprint)).toBe(true);
    });

    it("takes a point-in-time snapshot through the API (real EBS snapshot)", async () => {
      await expectStatus(await api(`/workspaces/${wsId}/snapshot`, { method: "POST" }), 200);
      expect((await inspect()).latestSnapshotId).toMatch(/^snap-/);
    });

    it("stop scales to zero: the sim ECS task really stops, bindings clear", async () => {
      const res = await expectStatus(
        await api(`/workspaces/${wsId}/stop`, { method: "POST" }),
        200,
      );
      expect(workspace.parse(await res.json()).state).toBe("stopped");

      const detail = await inspect();
      expect(detail.taskId).toBeUndefined();
      expect(detail.volumeId).toBeUndefined();
      expect(detail.latestSnapshotId).toMatch(/^snap-/);

      await awaitTaskStatus(firstTaskId, "STOPPED");
    });

    it("wake-on-connect hydrates a NEW task from the snapshot", async () => {
      const res = await expectStatus(
        await api(`/workspaces/${wsId}/connect`, { method: "POST" }),
        200,
      );
      expect(workspace.parse(await res.json()).state).toBe("running");

      const detail = await inspect();
      const newTask = required(detail.taskId, "taskId");
      expect(newTask).not.toBe(firstTaskId);
      expect(required(detail.volumeId, "volumeId")).not.toBe(firstVolumeId);
      expect(detail.sshHost).toMatch(/^10\.72\.1\.\d+$/);
      await awaitTaskStatus(newTask, "RUNNING");
    });

    it("delete removes the workspace and stops its task", async () => {
      const detail = await inspect();
      const taskArn = required(detail.taskId, "taskId");
      await expectStatus(await api(`/workspaces/${wsId}`, { method: "DELETE" }), 204);
      expect((await api(`/workspaces/${wsId}`)).status).toBe(404);

      await awaitTaskStatus(taskArn, "STOPPED");
    });
  },
);
