// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { workspaceId } from "./ids";
import { decideWorkspaceAccessBySubject, workspaceIdFromPath } from "./proxy-authz";

describe("workspaceIdFromPath", () => {
  it("extracts the id from /w/<id>/…", () => {
    expect(workspaceIdFromPath("/w/ws-abc123/")).toBe(workspaceId("ws-abc123"));
    expect(workspaceIdFromPath("/w/ws-abc123/static/main.js")).toBe(workspaceId("ws-abc123"));
    expect(workspaceIdFromPath("/w/ws-abc123")).toBe(workspaceId("ws-abc123"));
  });

  it("returns undefined for a non-/w path, a non-ws label, or a traversal attempt", () => {
    expect(workspaceIdFromPath("/admin")).toBeUndefined();
    expect(workspaceIdFromPath("/w/")).toBeUndefined();
    expect(workspaceIdFromPath("/w/not-a-workspace/")).toBeUndefined(); // no ws- prefix
    expect(workspaceIdFromPath("/w/ws-../../etc/")).toBeUndefined(); // bad chars → no match
    expect(workspaceIdFromPath("/w/WS-ABC/")).toBeUndefined(); // labels are lowercase
  });
});

describe("decideWorkspaceAccessBySubject", () => {
  it("an admin reaches any workspace", () => {
    expect(
      decideWorkspaceAccessBySubject({ callerSubject: "u-1", callerIsAdmin: true, ownerId: "u-2" }),
    ).toBe(true);
  });

  it("the owner (subject == ownerId) is allowed", () => {
    expect(
      decideWorkspaceAccessBySubject({
        callerSubject: "u-1",
        callerIsAdmin: false,
        ownerId: "u-1",
      }),
    ).toBe(true);
  });

  it("a non-owner non-admin is denied", () => {
    expect(
      decideWorkspaceAccessBySubject({
        callerSubject: "u-1",
        callerIsAdmin: false,
        ownerId: "u-2",
      }),
    ).toBe(false);
  });

  it("fails closed when the caller has no subject (non-admin)", () => {
    expect(
      decideWorkspaceAccessBySubject({
        callerSubject: undefined,
        callerIsAdmin: false,
        ownerId: "u-1",
      }),
    ).toBe(false);
  });
});
