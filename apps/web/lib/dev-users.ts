// SPDX-License-Identifier: AGPL-3.0-or-later
import { devPassword, devUsers, type DevUser } from "@edd/config";

export type { DevUser };

/**
 * Pure: the seeded account matching `username` whose password checks out, else
 * `null`. An account's expected password is its own `password` or, failing that,
 * the shared `fallbackPassword`. `users`/`fallbackPassword` are passed in so this
 * is deterministically testable (no env/config read).
 */
export function matchDevUser(
  users: readonly DevUser[],
  username: string,
  password: string,
  fallbackPassword: string,
): DevUser | null {
  const user = users.find((u) => u.username === username);
  if (user === undefined) return null;
  const expected = user.password ?? fallbackPassword;
  return password === expected ? user : null;
}

/** Authenticate against the configured seeded accounts (`@edd/config`). */
export function findDevUser(username: string, password: string): DevUser | null {
  return matchDevUser(devUsers(), username, password, devPassword());
}
