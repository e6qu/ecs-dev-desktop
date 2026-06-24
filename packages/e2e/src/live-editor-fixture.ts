// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared bits for the live editor-flow e2e (OpenVSCode + Monaco): the golden image under test +
// the create-a-running-workspace step, so each editor's suite only carries what's editor-specific.
import { randomBytes } from "node:crypto";

import { workspace, type WorkspaceDto } from "@edd/api-contracts";
import { dynamodb } from "@edd/config";
import type { EditorKind } from "@edd/core";
import { expect } from "vitest";

import { configureAwsSimEnv } from "./aws-sim";
import { startLiveEcsApp, type LiveEcsApp } from "./live-ecs-app";
import { devHeaders } from "./web-app";

export type { LiveEcsApp } from "./live-ecs-app";

/** The golden workspace image the live suites launch (overridable for a published image). */
export const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";

/** Point a live suite at the sim AWS env + DynamoDB Local (call once at module load). */
export function initLiveEnv(): void {
  configureAwsSimEnv();
  process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;
}

/** A fresh 32-byte hex secret (agent / connection HMAC master key). */
export const newSecret = (): string => randomBytes(32).toString("hex");

/** Start the live ECS app for an editor suite (golden image + per-suite CIDRs + secret). */
export async function startEditorApp(opts: {
  runId: string;
  vpcCidr: string;
  subnetCidr: string;
  connectionSecret: string;
  editor?: EditorKind;
}): Promise<LiveEcsApp> {
  return startLiveEcsApp({
    runId: opts.runId,
    workspaceImage: WORKSPACE_IMAGE,
    vpcCidr: opts.vpcCidr,
    subnetCidr: opts.subnetCidr,
    agentSecret: newSecret(),
    extraEnv: { EDD_CONNECTION_SECRET: opts.connectionSecret },
    ...(opts.editor === undefined ? {} : { editor: opts.editor }),
  });
}

/** Create a workspace through the real HTTP API and assert it reached `running`. */
export async function createRunningWorkspace(
  app: LiveEcsApp,
  owner: string,
): Promise<WorkspaceDto> {
  const created = await fetch(`${app.web.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: devHeaders(owner, "member"),
    body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
  });
  expect(created.status).toBe(201);
  const ws = workspace.parse(await created.json());
  expect(ws.state).toBe("running");
  return ws;
}
