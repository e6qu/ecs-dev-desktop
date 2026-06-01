// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH gateway = Teleport (auth, audit, session recording, Remote-SSH). Teleport
 * itself is deployed declaratively (see README); this package owns the small
 * amount of derived config — e.g. the SSH principal a user maps to on a
 * workspace node — kept pure so it is testable.
 */
export function workspacePrincipal(username: string): string {
  // Workspaces run as a single non-root user; the gateway authorises the human
  // identity, then connects as this principal.
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(username)) {
    throw new Error(`invalid username for SSH principal: ${username}`);
  }
  return `dev-${username}`;
}
