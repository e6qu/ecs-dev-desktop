// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { dynamodb } from "@edd/config";
import { WorkspaceService } from "@edd/control-plane";
import {
  baseImage,
  ownerId,
  systemClock,
  unwrap,
  workspaceId,
  workspacePrincipal,
} from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { awsSimClientConfig, configureAwsSimEnv, createVpcWithEgress, required } from "./aws-sim";
import { runSshClientTask, signWorkspaceCert, waitForTask } from "./golden-ssh-helpers";

/**
 * Data durability across a REAL scale-to-zero cycle, driven through
 * WorkspaceService (not raw storage primitives like workspace-data-fidelity).
 *
 *   create golden workspace → SSH in, write a marker+checksum to /home/workspace
 *   (the managed-EBS mount) → service.stop() (snapshot via the control plane) →
 *   service.connect() (wake: a NEW task hydrates a fresh volume from that
 *   snapshot) → SSH into the woken task → the file is present and byte-identical.
 *
 * This proves the product's headline promise — your work survives scale-to-zero
 * — end to end through the lifecycle, with the data observed from inside the
 * workspace over SSH (the way a user reaches it), not just at the EBS API.
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const TABLE = `edd-durability-${RUN_ID}`;
const CLUSTER = `edd-durability-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/durability-${RUN_ID}`;
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const AGENT_SECRET = "d2".repeat(32);
const CONTROL_PLANE_URL = "http://127.0.0.1:3000"; // idle-agent heartbeats fail harmlessly
const SUBNET_CIDR_RE = /^10\.76\.1\.\d+$/;

const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");
const CA_KEY = join(SSH_CA_DIR, "ca");
const CA_PUB = join(SSH_CA_DIR, "ca.pub");
const USER_KEY = join(SSH_CA_DIR, `durability-${RUN_ID}`);

const SIM = awsSimClientConfig();

describe(
  "workspace data durability across scale-to-zero (real lifecycle)",
  { timeout: 600_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    let dynamo: ReturnType<typeof createDynamoClient>;
    let service: WorkspaceService;
    let subnetId: string;

    beforeAll(async () => {
      const vpc = await createVpcWithEgress(ec2, {
        vpcCidr: "10.76.0.0/16",
        subnetCidr: "10.76.1.0/24",
        securityGroupName: `durability-sg-${RUN_ID}`,
      });
      subnetId = vpc.subnetId;
      await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
      await new CloudWatchLogsClient(SIM).send(
        new CreateLogGroupCommand({ logGroupName: LOG_GROUP }),
      );

      dynamo = createDynamoClient();
      await dropTable(dynamo, TABLE);
      await ensureTable(dynamo, TABLE);
      service = new WorkspaceService({
        workspaces: makeWorkspaceEntity(dynamo, TABLE),
        storage: Ec2StorageProvider.fromEnv(),
        compute: new EcsComputeProvider({
          client: ecs,
          config: {
            cluster: CLUSTER,
            subnets: [subnetId],
            ebsRoleArn: EBS_ROLE,
            controlPlaneUrl: CONTROL_PLANE_URL,
            agentSecret: AGENT_SECRET,
            sshCaPublicKey: readFileSync(CA_PUB, "utf8").trim(),
            logGroupName: LOG_GROUP,
          },
        }),
        clock: systemClock,
      });
    });

    afterAll(async () => {
      await dropTable(dynamo, TABLE);
      for (const p of [USER_KEY, `${USER_KEY}.pub`, `${USER_KEY}-cert.pub`])
        rmSync(p, { force: true });
    });

    it("a file written into a workspace survives stop → snapshot → wake", async () => {
      // 1. Create the workspace (real golden-image task + managed EBS).
      const ws = await service.create({
        ownerId: ownerId("durable-user"),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      const created = await service.inspect(workspaceId(ws.id));
      const firstTask = required(created?.workspace.taskId, "taskId");
      const firstHost = required(created?.workspace.sshHost, "sshHost");
      expect(firstHost).toMatch(SUBNET_CIDR_RE);
      await waitForTask(ecs, CLUSTER, firstTask, "RUNNING");

      // 2. SSH in and write a unique marker + its checksum to the managed mount.
      const cred = signWorkspaceCert(
        CA_KEY,
        USER_KEY,
        workspacePrincipal(ws.id),
        `durable-${RUN_ID}`,
      );
      const marker = `edd-durable-${RUN_ID}-${randomUUID().slice(0, 8)}`;
      const writeExit = await runSshClientTask(ecs, {
        cluster: CLUSTER,
        subnetId,
        image: WORKSPACE_IMAGE,
        logGroup: LOG_GROUP,
        family: `durability-writer-${RUN_ID}`,
        host: firstHost,
        cred,
        remoteCmd: `printf %s '${marker}' > /home/workspace/persist.txt && sha256sum /home/workspace/persist.txt > /home/workspace/persist.sha && sync`,
      });
      expect(writeExit, "writing the marker over SSH should succeed").toBe(0);

      // 3. Scale to zero — the control plane snapshots the managed volume.
      const stopped = unwrap(await service.stop(workspaceId(ws.id)));
      expect(stopped.state).toBe("stopped");
      const stoppedDetail = await service.inspect(workspaceId(ws.id));
      expect(stoppedDetail?.workspace.latestSnapshotId).toMatch(/^snap-/);

      // 4. Wake — a NEW task hydrates a fresh volume from that snapshot.
      const woken = unwrap(await service.connect(workspaceId(ws.id)));
      expect(woken.state).toBe("running");
      const wokenDetail = await service.inspect(workspaceId(ws.id));
      const secondTask = required(wokenDetail?.workspace.taskId, "woken taskId");
      const secondHost = required(wokenDetail?.workspace.sshHost, "woken sshHost");
      expect(secondTask).not.toBe(firstTask);
      await waitForTask(ecs, CLUSTER, secondTask, "RUNNING");

      // 5. SSH into the WOKEN task: the file is present and byte-identical.
      const verifyExit = await runSshClientTask(ecs, {
        cluster: CLUSTER,
        subnetId,
        image: WORKSPACE_IMAGE,
        logGroup: LOG_GROUP,
        family: `durability-reader-${RUN_ID}`,
        host: secondHost,
        cred,
        remoteCmd: `cd /home/workspace && sha256sum -c persist.sha && grep -q '${marker}' persist.txt`,
      });
      expect(verifyExit, "the marker must survive scale-to-zero byte-for-byte").toBe(0);

      await service.remove(workspaceId(ws.id));
    });
  },
);
