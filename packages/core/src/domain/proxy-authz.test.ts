// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { email, workspaceId } from "./ids";
import {
  decideWorkspaceAccess,
  decideWorkspaceAccessBySubject,
  workspaceIdFromHost,
  workspaceIdFromPath,
} from "./proxy-authz";

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

describe("workspaceIdFromHost", () => {
  const domain = "devbox.localhost";

  it("extracts the workspace id from the leftmost label", () => {
    expect(workspaceIdFromHost("ws-abc123.devbox.localhost", domain)).toBe(
      workspaceId("ws-abc123"),
    );
  });

  it("is case-insensitive on the host (DNS labels are)", () => {
    expect(workspaceIdFromHost("WS-AbC.DevBox.LocalHost", domain)).toBe(workspaceId("ws-abc"));
  });

  it("strips a port if present", () => {
    expect(workspaceIdFromHost("ws-abc.devbox.localhost:8443", domain)).toBe(workspaceId("ws-abc"));
  });

  it("rejects a host not under the base domain", () => {
    expect(workspaceIdFromHost("ws-abc.evil.example", domain)).toBeUndefined();
  });

  it("rejects the bare base domain (no workspace label)", () => {
    expect(workspaceIdFromHost("devbox.localhost", domain)).toBeUndefined();
  });

  it("rejects a multi-label subdomain (only a single workspace label is valid)", () => {
    expect(workspaceIdFromHost("a.ws-abc.devbox.localhost", domain)).toBeUndefined();
  });

  it("rejects a label that is not a workspace id (wrong prefix)", () => {
    expect(workspaceIdFromHost("health.devbox.localhost", domain)).toBeUndefined();
  });

  it("rejects a label that fails the workspace-principal charset", () => {
    expect(workspaceIdFromHost("ws-AB_CD.devbox.localhost", domain)).toBeUndefined();
  });

  it("rejects empty/garbage hosts", () => {
    expect(workspaceIdFromHost("", domain)).toBeUndefined();
    expect(workspaceIdFromHost(".devbox.localhost", domain)).toBeUndefined();
  });
});

describe("decideWorkspaceAccess", () => {
  const owner = email("owner@edd.test");
  const other = email("other@edd.test");

  it("allows the owner (email match, case-insensitive)", () => {
    expect(
      decideWorkspaceAccess({
        callerEmail: email("OWNER@EDD.TEST"),
        callerIsAdmin: false,
        ownerEmail: owner,
      }),
    ).toBe(true);
  });

  it("denies a different authenticated user", () => {
    expect(
      decideWorkspaceAccess({ callerEmail: other, callerIsAdmin: false, ownerEmail: owner }),
    ).toBe(false);
  });

  it("allows an admin regardless of ownership", () => {
    expect(
      decideWorkspaceAccess({ callerEmail: other, callerIsAdmin: true, ownerEmail: owner }),
    ).toBe(true);
  });

  it("fails closed when the workspace has no recorded owner email (non-admin)", () => {
    expect(
      decideWorkspaceAccess({ callerEmail: owner, callerIsAdmin: false, ownerEmail: undefined }),
    ).toBe(false);
  });

  it("an admin still passes when owner email is unknown", () => {
    expect(
      decideWorkspaceAccess({ callerEmail: undefined, callerIsAdmin: true, ownerEmail: undefined }),
    ).toBe(true);
  });

  it("fails closed when the caller has no email (non-admin)", () => {
    expect(
      decideWorkspaceAccess({ callerEmail: undefined, callerIsAdmin: false, ownerEmail: owner }),
    ).toBe(false);
  });
});
