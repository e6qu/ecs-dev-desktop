// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { GET as auditGet } from "./audit/route";
import { GET as configSyncGet } from "./config-sync/route";
import { GET as healthGet } from "./health/route";
import { GET as logsGet } from "./logs/route";
import { GET as overviewGet } from "./overview/route";
import { GET as quotasGet } from "./quotas/route";
import { GET as inspectGet } from "./workspaces/[id]/route";
import { GET as workspacesGet } from "./workspaces/route";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;

// The admin RBAC gate (role/auth check) short-circuits before any control-plane/DB
// call — and, for logs, before the `?stream=` parse — so these are pure auth
// checks that need no DynamoDB and no query param.
const ADMIN = "http://localhost/api/admin";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// Each admin endpoint, invoked uniformly so the role gate is exercised the same way.
const ENDPOINTS: { name: string; call: (req: Request) => Promise<Response> }[] = [
  { name: "health", call: (req) => healthGet(req) },
  { name: "workspaces", call: (req) => workspacesGet(req) },
  { name: "workspaces/:id", call: (req) => inspectGet(req, params("ws-x")) },
  { name: "audit", call: (req) => auditGet(req) },
  { name: "logs", call: (req) => logsGet(req) },
  { name: "config-sync", call: (req) => configSyncGet(req) },
  { name: "quotas", call: (req) => quotasGet(req) },
  { name: "overview", call: (req) => overviewGet(req) },
];

function asRole(role: string): Request {
  return new Request(ADMIN, { headers: { [USER_ID_HEADER]: "mallory", [ROLE_HEADER]: role } });
}

describe("admin API authorization (RBAC gate)", () => {
  for (const ep of ENDPOINTS) {
    it(`denies a member with 403: ${ep.name}`, async () => {
      expect((await ep.call(asRole("member"))).status).toBe(403);
    });

    it(`denies a viewer with 403: ${ep.name}`, async () => {
      expect((await ep.call(asRole("viewer"))).status).toBe(403);
    });

    it(`rejects an unauthenticated request with 401: ${ep.name}`, async () => {
      expect((await ep.call(new Request(ADMIN))).status).toBe(401);
    });
  }
});
