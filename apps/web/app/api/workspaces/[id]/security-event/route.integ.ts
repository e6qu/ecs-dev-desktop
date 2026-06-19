// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiBase,
  createWorkspaceFor,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { AGENT_SECRET_ENV } from "../../../../../lib/constants";
import { POST as securityEvent } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-security-event-integ");

const TEST_SECRET = "b".repeat(64);

function agentToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(TEST_SECRET, "hex")).update(wsId).digest("hex");
}

function report(id: string, body: unknown, token?: string): Promise<Response> {
  return securityEvent(
    new Request(`${apiBase}/${id}/security-event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token ?? agentToken(id)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    routeCtx(id),
  );
}

describe("POST /api/workspaces/:id/security-event (DynamoDB Local)", () => {
  beforeEach(() => {
    vi.stubEnv(AGENT_SECRET_ENV, TEST_SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a privilege_attempt with a valid agent token (202)", async () => {
    const id = await createWorkspaceFor("sec-user-1");
    expect((await report(id, { kind: "privilege_attempt", tool: "docker" })).status).toBe(202);
  });

  it("rejects a wrong agent token (401) — only the in-workspace agent may report", async () => {
    const id = await createWorkspaceFor("sec-user-2");
    expect((await report(id, { kind: "privilege_attempt", tool: "sudo" }, "deadbeef")).status).toBe(
      401,
    );
  });

  it("rejects a malformed body (400)", async () => {
    const id = await createWorkspaceFor("sec-user-3");
    expect((await report(id, { kind: "nope", tool: "" })).status).toBe(400);
    expect((await report(id, { kind: "privilege_attempt", tool: "bad tool!" })).status).toBe(400);
  });
});
