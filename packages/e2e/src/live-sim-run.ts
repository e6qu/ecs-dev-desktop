// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive live harness (NOT a test): bring up the REAL control plane on the
// container-mode sockerless sim with a real ECS cluster, seed the golden catalog,
// and block so the app can be driven in a browser (dev-auth on). Prints the web
// URL + cluster coordinates as JSON, then stays running until Ctrl-C.
//
//   tsx packages/e2e/src/live-sim-run.ts
//
// Endpoint-only (§6.8): the same code targets real AWS by changing coordinates.
import { randomBytes } from "node:crypto";

import { workspace } from "@edd/api-contracts";
import { dynamodb } from "@edd/config";

import { configureAwsSimEnv } from "./aws-sim";
import { startIdeBridge } from "./ide-bridge";
import { startLiveEcsApp } from "./live-ecs-app";
import { devHeaders } from "./web-app";

configureAwsSimEnv();
// Pin DynamoDB to the standalone DynamoDB-Local container (8000), not the sim's
// own DynamoDB (reached via AWS_ENDPOINT_URL): the harness and the web app must
// agree on one store, or the app reads an empty table the harness never wrote to.
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";

const app = await startLiveEcsApp({
  runId: "interactive",
  workspaceImage: WORKSPACE_IMAGE,
  vpcCidr: "10.70.0.0/16",
  subnetCidr: "10.70.1.0/24",
  agentSecret: randomBytes(32).toString("hex"),
  connectionSecret: randomBytes(32).toString("hex"),
});

// Create one workspace through the real API (real RunTask on the sim cluster) and
// bridge into its task so the actual OpenVSCode workbench is openable in a browser.
const created = await fetch(`${app.web.baseUrl}/api/workspaces`, {
  method: "POST",
  headers: devHeaders("root", "admin"),
  body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
});
if (created.status !== 201) {
  throw new Error(
    `workspace create failed: HTTP ${String(created.status)} ${await created.text()}`,
  );
}
const ws = workspace.parse(await created.json());
const bridge = await startIdeBridge({ workspaceId: ws.id, image: WORKSPACE_IMAGE, port: 13000 });

console.log(
  JSON.stringify(
    {
      ready: true,
      webUrl: app.web.baseUrl,
      cluster: app.cluster,
      subnetId: app.subnetId,
      securityGroupId: app.securityGroupId,
      workspaceId: ws.id,
      ideUrl: bridge.url,
    },
    null,
    2,
  ),
);
console.log(
  `\nLIVE:\n  web UI : ${app.web.baseUrl}/login   (dev-auth: admin / dev)\n  IDE    : ${bridge.url}\n\nNote: the IDE bridge is pinned to this workspace's task container + per-boot token;\nif the task is recreated, re-run this harness. Ctrl-C to stop.`,
);

// Block forever so the web app + bridge stay up for interactive use.
await new Promise(() => {
  /* run until the process is killed */
});
