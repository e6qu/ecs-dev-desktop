// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Email, type WorkspaceId, workspaceId } from "./ids";

/**
 * Pure decisions for per-workspace proxy authorization (DO_NEXT #5). The
 * identity-aware proxy (Pomerium) authenticates the caller and the gate forwards
 * a verified identity; these functions are the I/O-free core that maps a
 * workspace host to its id and decides whether a caller may reach it. The
 * imperative shell (the `/api/internal/authz` route) verifies the proxy JWT,
 * loads the workspace, and calls these.
 */

/** The same charset the SSH workspace principal enforces — a workspace id is a
 * valid single DNS label, so the proxy subdomain and the SSH principal agree. */
const WORKSPACE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
/** Workspace ids are `ws-` prefixed (see `ID_PREFIX.workspace`). Repeated here
 * as a local literal to keep this module free of cross-imports; the test pins
 * them together. */
const WORKSPACE_ID_PREFIX = "ws-";

/**
 * Extract the workspace id from a request host of the form
 * `<ws-id>.<baseDomain>` (e.g. `ws-abc.devbox.localhost`). Returns `undefined`
 * — never throws — when the host is not a single workspace label under the
 * configured base domain, so the caller fails closed (deny). A port suffix is
 * tolerated; matching is case-insensitive (DNS labels are).
 */
export function workspaceIdFromHost(host: string, baseDomain: string): WorkspaceId | undefined {
  const hostname = host.split(":", 1)[0]?.toLowerCase() ?? "";
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const label = hostname.slice(0, -suffix.length);
  if (!label.startsWith(WORKSPACE_ID_PREFIX)) return undefined;
  if (!WORKSPACE_LABEL_RE.test(label)) return undefined;
  return workspaceId(label);
}

export interface WorkspaceAccessInput {
  /** The proxy-verified caller email (from the identity assertion), if present. */
  readonly callerEmail: Email | undefined;
  /** Whether the caller's mapped role is admin (admins reach any workspace). */
  readonly callerIsAdmin: boolean;
  /** The workspace's recorded owner email, if any. */
  readonly ownerEmail: Email | undefined;
}

/**
 * Decide whether a caller may reach a workspace through the proxy. Admins always
 * may. Otherwise the caller's email must equal the workspace owner's email (both
 * already lowercase-normalised by the `email` smart constructor). Fails closed:
 * a missing caller email or a workspace with no recorded owner email denies a
 * non-admin.
 */
export function decideWorkspaceAccess(input: WorkspaceAccessInput): boolean {
  if (input.callerIsAdmin) return true;
  if (input.callerEmail === undefined || input.ownerEmail === undefined) return false;
  return input.callerEmail === input.ownerEmail;
}
