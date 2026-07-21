// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium, type BrowserContext } from "@playwright/test";

import type { StoredCookie } from "./deployed-workspace-smoke-lib";

type BrowserCookie = Parameters<BrowserContext["addCookies"]>[0][number];

export interface DeployedShauthSession {
  readonly applicationCookies: StoredCookie[];
  readonly browserCookies: readonly BrowserCookie[];
}

function exactOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin;
}

function applicationCookies(
  cookies: readonly BrowserCookie[],
  applicationHostname: string,
): StoredCookie[] {
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain?.replace(/^\./, "");
      return domain === applicationHostname || applicationHostname.endsWith(`.${domain ?? ""}`);
    })
    .map((cookie) => ({ name: cookie.name, value: cookie.value, path: cookie.path ?? "/" }));
}

async function browserCookies(context: BrowserContext): Promise<readonly BrowserCookie[]> {
  return (await context.cookies()).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}

/**
 * Establishes a deployed application session only through its Shauth OpenID
 * Connect entry point. Credentials are entered after the browser has reached
 * the exact configured Shauth origin and are never sent to ECS Dev Desktop.
 */
export async function signInToDeployedApp(
  applicationUrl: string,
  shauthIssuer: string,
  username: string,
  password: string,
): Promise<DeployedShauthSession> {
  const application = new URL(applicationUrl);
  const providerOrigin = exactOrigin(shauthIssuer);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${application.origin}/login/shauth`);
    await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page.waitForURL((url) => url.origin === application.origin, { timeout: 30_000 });
    await page.getByRole("heading", { name: "Your workspaces" }).waitFor();

    const cookies = await browserCookies(context);
    const appCookies = applicationCookies(cookies, application.hostname);
    if (appCookies.length === 0) {
      throw new Error("Shauth login completed without an ECS Dev Desktop application cookie");
    }
    return { applicationCookies: appCookies, browserCookies: cookies };
  } finally {
    await browser.close();
  }
}

/** Ends the same central Shauth session and proves the browser returned to the
 * stable application-owned signed-out page. */
export async function signOutOfDeployedApp(
  applicationUrl: string,
  session: DeployedShauthSession,
): Promise<void> {
  const application = new URL(applicationUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([...session.browserCookies]);
    const page = await context.newPage();
    await page.goto(`${application.origin}/workspaces`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(
      (url) => url.origin === application.origin && url.pathname === "/signed-out",
      { timeout: 30_000 },
    );
    await page.getByRole("heading", { name: "You are signed out" }).waitFor();
  } finally {
    await browser.close();
  }
}
