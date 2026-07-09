// SPDX-License-Identifier: AGPL-3.0-or-later
// Route-level authorization matrix. The ability unit matrix (packages/authz)
// proves the CASL rules; this proves every HTTP route actually enforces them.
// It fills the cells the per-route suites don't: the VIEWER role across every
// workspace verb, the admin-only catalog guard against a developer, and a uniform
// unauthenticated → 401 sweep. (developer-cross-owner → 403 lives in
// lifecycle-routes.integ; the admin routes in admin-authz.integ.)
import { describe, expect, it } from "vitest";

import { ROLE_HEADER, USER_ID_HEADER } from "../../lib/constants";
import {
  apiBase,
  createWorkspaceFor,
  routeCtx,
  useWorkspaceTable,
} from "../../lib/test-support/workspace-route-harness";
import { GET as listWorkspaces, POST as createWorkspace } from "./workspaces/route";
import {
  GET as getWorkspace,
  PATCH as updateWorkspace,
  DELETE as deleteWorkspace,
} from "./workspaces/[id]/route";
import { POST as startWs } from "./workspaces/[id]/start/route";
import { POST as stopWs } from "./workspaces/[id]/stop/route";
import { POST as snapshotWs } from "./workspaces/[id]/snapshot/route";
import { POST as connectWs } from "./workspaces/[id]/connect/route";
import { POST as heartbeatWs } from "./workspaces/[id]/heartbeat/route";
import { GET as connectInfo } from "./workspaces/[id]/connect-info/route";
import { GET as listBaseImages, POST as createBaseImage } from "./base-images/route";

// Route handlers ignore the request host/path (they read headers + body); these
// URLs are just well-formed placeholders.
const BASE_IMAGES_URL = "http://localhost/api/base-images";

useWorkspaceTable("ecs-dev-des-web-authz-matrix-integ");

/** Headers for a given role, or none (unauthenticated). */
function headers(role?: string): HeadersInit {
  if (role === undefined) return { "content-type": "application/json" };
  return {
    [USER_ID_HEADER]: `actor-${role}`,
    [ROLE_HEADER]: role,
    "content-type": "application/json",
  };
}

const req = (url: string, role: string | undefined, method = "GET", body?: unknown): Request =>
  new Request(url, {
    method,
    headers: headers(role),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const wsCollection = (role: string | undefined, method = "GET", body?: unknown) =>
  req(apiBase, role, method, body);
const catalog = (role: string | undefined, method = "GET", body?: unknown) =>
  req(BASE_IMAGES_URL, role, method, body);

describe("authorization matrix: collection routes", () => {
  it("unauthenticated callers get 401 on every collection route", async () => {
    expect((await listWorkspaces(wsCollection(undefined))).status).toBe(401);
    expect(
      (await createWorkspace(wsCollection(undefined, "POST", { baseImage: "golden/node:20" })))
        .status,
    ).toBe(401);
    expect((await listBaseImages(catalog(undefined))).status).toBe(401);
    expect(
      (await createBaseImage(catalog(undefined, "POST", { name: "x", image: "y" }))).status,
    ).toBe(401);
  });

  it("a viewer may browse but not create (workspaces + catalog)", async () => {
    expect((await listWorkspaces(wsCollection("viewer"))).status).toBe(200);
    expect((await listBaseImages(catalog("viewer"))).status).toBe(200);
    expect(
      (await createWorkspace(wsCollection("viewer", "POST", { baseImage: "golden/node:20" })))
        .status,
    ).toBe(403);
    expect(
      (await createBaseImage(catalog("viewer", "POST", { name: "x", image: "y" }))).status,
    ).toBe(403);
  });

  it("a developer cannot mutate the catalog (admin-only)", async () => {
    expect((await listBaseImages(catalog("developer"))).status).toBe(200);
    expect(
      (await createBaseImage(catalog("developer", "POST", { name: "x", image: "y" }))).status,
    ).toBe(403);
  });
});

describe("authorization matrix: item routes deny viewer and unauthenticated", () => {
  // Every body-less item verb, invoked uniformly.
  const item = (
    id: string,
    seg: string,
    role: string | undefined,
    method: string,
    body?: unknown,
  ) => req(`${apiBase}/${id}${seg}`, role, method, body);

  const itemRoutes: { name: string; call: (id: string, role?: string) => Promise<Response> }[] = [
    { name: "GET /:id", call: (id, r) => getWorkspace(item(id, "", r, "GET"), routeCtx(id)) },
    {
      name: "PATCH /:id",
      call: (id, r) =>
        updateWorkspace(
          item(id, "", r, "PATCH", { snapshotIntervalMs: 10 * 60 * 1000 }),
          routeCtx(id),
        ),
    },
    {
      name: "DELETE /:id",
      call: (id, r) => deleteWorkspace(item(id, "", r, "DELETE"), routeCtx(id)),
    },
    {
      name: "POST /:id/start",
      call: (id, r) => startWs(item(id, "/start", r, "POST"), routeCtx(id)),
    },
    { name: "POST /:id/stop", call: (id, r) => stopWs(item(id, "/stop", r, "POST"), routeCtx(id)) },
    {
      name: "POST /:id/snapshot",
      call: (id, r) => snapshotWs(item(id, "/snapshot", r, "POST"), routeCtx(id)),
    },
    {
      name: "POST /:id/connect",
      call: (id, r) => connectWs(item(id, "/connect", r, "POST"), routeCtx(id)),
    },
    {
      name: "POST /:id/heartbeat",
      call: (id, r) => heartbeatWs(item(id, "/heartbeat", r, "POST"), routeCtx(id)),
    },
    {
      name: "GET /:id/connect-info",
      call: (id, r) => connectInfo(item(id, "/connect-info", r, "GET"), routeCtx(id)),
    },
  ];

  itemRoutes.forEach((route, i) => {
    it(`${route.name}: viewer → 403, unauthenticated → 401`, async () => {
      // A distinct owner per case so the shared developer workspace quota (5) is
      // never the thing that fails.
      const id = await createWorkspaceFor(`owner-${String(i)}`);
      expect((await route.call(id, "viewer")).status, "viewer must be forbidden").toBe(403);
      expect((await route.call(id, undefined)).status, "unauth must be 401").toBe(401);
    });
  });
});
