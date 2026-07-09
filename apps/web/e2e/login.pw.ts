// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from "@playwright/test";

import { TESTID } from "../lib/testids";
import { sel } from "./support";

/**
 * Dev-login form (EDD_DEV_AUTH=1): sign in as the seeded accounts and assert
 * role-appropriate access. Drives the real form (not the cookie shim) so the
 * login flow itself is covered. Seeded accounts with explicit passwords come
 * from @edd/config (no EDD_DEV_USERS set in this run).
 */
async function formLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator(sel(TESTID.loginUser)).selectOption(username);
  await page.locator(sel(TESTID.loginPassword)).fill(password);
  await page.locator(sel(TESTID.loginSubmit)).click();
}

test("admin signs in and reaches the admin console", async ({ page }) => {
  await formLogin(page, "admin", "dev");
  await page.waitForURL("**/admin/overview");

  // The admin Overview renders (stat tiles) and the top-bar shows the admin nav.
  // The link lookup is SCOPED to the primary nav: the signed-in user's own name is
  // "admin" here, and their /me account link would otherwise be a second role=link
  // match (getByRole name matching is substring-based) — the nav entry is what this
  // asserts, not any text that happens to say "admin".
  await expect(page.locator(sel(TESTID.statTile)).first()).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "admin" }),
  ).toBeVisible();
});

test("developer signs in but is denied the admin console", async ({ page }) => {
  await formLogin(page, "developer", "dev");
  await page.waitForURL("**/workspaces");

  await page.goto("/admin");
  await expect(page.locator(sel(TESTID.adminDenied))).toBeVisible();
});

test("viewer signs in but is denied the admin console", async ({ page }) => {
  await formLogin(page, "viewer", "dev");
  await page.waitForURL("**/workspaces");

  await page.goto("/admin");
  await expect(page.locator(sel(TESTID.adminDenied))).toBeVisible();
});

test("a wrong password is rejected with an error on the login page", async ({ page }) => {
  await formLogin(page, "admin", "not-the-password");
  await page.waitForURL("**/login?error=invalid");
  await expect(page.locator(sel(TESTID.loginError))).toBeVisible();
  // Still unauthenticated: the dev sign-in form is shown again.
  await expect(page.locator(sel(TESTID.loginSubmit))).toBeVisible();
});

test("sign-out clears the session and returns to the login form", async ({ page }) => {
  await formLogin(page, "admin", "dev");
  await page.waitForURL("**/admin/overview");

  await page.getByRole("button", { name: "sign out" }).click();
  await page.waitForURL("**/login");
  // Back to the dev login form; the top-bar no longer shows a signed-in user.
  await expect(page.locator(sel(TESTID.loginSubmit))).toBeVisible();
  await expect(page.getByRole("button", { name: "sign out" })).toHaveCount(0);
});
