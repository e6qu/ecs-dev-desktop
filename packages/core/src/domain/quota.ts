// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether a user who already owns `count` workspaces may create another, given
 * their role's `limit` (`null` = unlimited). The per-role limits and current
 * count are supplied by the shell; this is the pure gate.
 */
export function withinWorkspaceQuota(count: number, limit: number | null): boolean {
  return limit === null || count < limit;
}
