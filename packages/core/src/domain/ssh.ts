// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH principal a workspace container runs as. The gateway authenticates the
 * human identity (via our SSH CA cert), then connects as this system user.
 * `AuthorizedPrincipalsFile` in the workspace node's sshd_config maps the
 * OS user to the allowed certificate principal — they must match.
 */
export function workspacePrincipal(workspaceId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(workspaceId)) {
    throw new Error(`invalid workspaceId for SSH principal: ${workspaceId}`);
  }
  return `dev-${workspaceId}`;
}
