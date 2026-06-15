// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Capture screenshots of the running local dev UI by signing in through the
 * dev-auth login form (`EDD_DEV_AUTH=1`). A reusable dev aid — start the app
 * (`pnpm dev`) in another terminal, then `pnpm --filter @edd/web screenshot`.
 *
 * Config via env (all optional):
 *   EDD_SHOT_BASE      base URL (default http://edd.localhost:3700)
 *   EDD_SHOT_OUT       output dir (default <tmp>/edd-screenshots)
 *   EDD_SHOT_USER      seeded username to sign in as (default admin)
 *   EDD_SHOT_PASSWORD  dev password (default dev)
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { TESTID } from "../lib/testids";

const BASE = process.env.EDD_SHOT_BASE ?? "http://edd.localhost:3700";
const OUT = process.env.EDD_SHOT_OUT ?? join(tmpdir(), "edd-screenshots");
const USER = process.env.EDD_SHOT_USER ?? "admin";
const PASSWORD = process.env.EDD_SHOT_PASSWORD ?? "dev";

/** Pages to capture after signing in (path → file stem). */
const PAGES: readonly (readonly [string, string])[] = [
  ["/admin/overview", "overview"],
  ["/admin/health", "health"],
  ["/admin/logs", "logs"],
  ["/admin/costs", "costs"],
  ["/workspaces", "workspaces"],
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto("/login");
  await page.screenshot({ path: join(OUT, "login.png") });

  await page.locator(`[data-testid="${TESTID.loginUser}"]`).selectOption(USER);
  await page.locator(`[data-testid="${TESTID.loginPassword}"]`).fill(PASSWORD);
  await page.locator(`[data-testid="${TESTID.loginSubmit}"]`).click();
  await page.waitForLoadState("networkidle");

  for (const [path, name] of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  }

  await browser.close();
  console.log(`captured ${String(PAGES.length + 1)} screenshots to ${OUT}/`);
}

await main();
