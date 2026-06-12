// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the Playwright specs (fake-adapter portal.pw.ts and the
// live-adapter portal.pwlive.ts): typed test-id selectors and dev-auth login.
import type { BrowserContext } from "@playwright/test";

import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "../lib/constants";
import type { TestId } from "../lib/testids";

/** A CSS selector for a test-id, optionally narrowed by `data-*` attributes —
 * locate by id, assert on the typed attributes, never on rendered text. */
export function sel(id: TestId, attrs: Record<string, string> = {}): string {
  const filters = Object.entries(attrs)
    .map(([k, v]) => `[${k}="${v}"]`)
    .join("");
  return `[data-testid="${id}"]${filters}`;
}

/** Sign in by setting the dev-auth cookies the browser carries (EDD_DEV_AUTH=1).
 * Cookies are set by `url` (not `domain`): a Domain attribute is invalid for an
 * IP literal, so these must be host-only. */
export async function loginAs(
  context: BrowserContext,
  baseUrl: string,
  id: string,
  role: string,
): Promise<void> {
  await context.addCookies([
    { name: DEV_USER_COOKIE, value: id, url: baseUrl },
    { name: DEV_ROLE_COOKIE, value: role, url: baseUrl },
  ]);
}

/** Cookie header for API requests made directly from the spec. */
export function devCookieHeader(id: string, role: string): string {
  return `${DEV_USER_COOKIE}=${id}; ${DEV_ROLE_COOKIE}=${role}`;
}
