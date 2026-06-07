// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH gateway: standard OpenSSH sshd + our own SSH CA (auth, audit, RBAC).
 * This package owns the pure, testable config — e.g. the SSH principal a user
 * maps to on a workspace node.
 */
export function workspacePrincipal(username: string): string {
  // Workspaces run as a single non-root user; the gateway authorises the human
  // identity, then connects as this principal.
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(username)) {
    throw new Error(`invalid username for SSH principal: ${username}`);
  }
  return `dev-${username}`;
}
