// SPDX-License-Identifier: AGPL-3.0-or-later
import { type WorkspaceId, workspaceId } from "./ids";

/**
 * Pure decisions for the in-app, path-based per-workspace proxy. The single
 * Next.js app authenticates the browser against its own Auth.js session and
 * proxies `/w/<id>/…` to the workspace editor; these I/O-free functions map a
 * request path to a workspace id and decide whether the caller may reach it. The
 * imperative shell (`apps/web/lib/workspace-proxy.ts`, run from the custom
 * server) decodes the session, loads the workspace, and calls these.
 */

/** The same charset the SSH workspace principal enforces — a workspace id is a
 * valid single DNS label, so the proxy path segment and the SSH principal agree.
 * Requires the `ws-` prefix plus at least one further char (a bare "ws-" is not a
 * real, generated id — every real id has a non-empty random suffix); max total
 * length 39 to match a `ws-<uuid>` id (3 + 36). */
const WORKSPACE_LABEL_RE = /^ws-[a-z0-9][a-z0-9-]{0,35}$/;

/** Path prefix under which each workspace's editor is proxied: `/w/<id>/…`. The
 * single-domain, path-based browser route (no wildcard DNS / subdomain). */
export const WORKSPACE_PATH_PREFIX = "/w/";

/**
 * Extract the workspace id from an in-app proxy path of the form `/w/<ws-id>/…`
 * (e.g. `/w/ws-abc/`). Returns `undefined` — never throws — when the first path
 * segment after `/w/` is not a valid `ws-` workspace label, so the caller fails
 * closed and a traversal/garbage id can't reach the control-plane lookup.
 */
export function workspaceIdFromPath(pathname: string): WorkspaceId | undefined {
  const match = /^\/w\/([^/?#]+)/.exec(pathname);
  const label = match?.[1];
  if (label === undefined) return undefined;
  if (!WORKSPACE_LABEL_RE.test(label)) return undefined;
  return workspaceId(label);
}

export interface WorkspaceAccessBySubjectInput {
  /** The authenticated caller's stable subject (the Auth.js session `uid`). */
  readonly callerSubject: string | undefined;
  /** Whether the caller's role is admin (admins reach any workspace). */
  readonly callerIsAdmin: boolean;
  /** The workspace's recorded owner id (the creator's subject). */
  readonly ownerId: string;
}

/**
 * Decide whether a caller may reach a workspace through the in-app proxy. Admins
 * always may; otherwise the caller's subject must equal the workspace owner's id.
 * With a single IdP (the portal's Auth.js session is also the proxy session) the
 * subject is stable across both, so this replaces the email bridge the two-IdP
 * Pomerium design needed. Fails closed: a missing caller subject denies a non-admin.
 */
export function decideWorkspaceAccessBySubject(input: WorkspaceAccessBySubjectInput): boolean {
  if (input.callerIsAdmin) return true;
  if (input.callerSubject === undefined || input.callerSubject.length === 0) return false;
  return input.callerSubject === input.ownerId;
}
