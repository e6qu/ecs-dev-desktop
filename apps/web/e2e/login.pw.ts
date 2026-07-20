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

function relativeLuminance(color: string): number {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (channels?.length !== 3) throw new Error(`could not parse browser color ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
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

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  // Back to the dev login form; the top-bar no longer shows a signed-in user.
  await expect(page.locator(sel(TESTID.loginSubmit))).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});

test("the relying-party signed-out landing stays on ECS Dev Desktop", async ({ page }) => {
  await page.goto("/signed-out");

  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.getByRole("heading", { name: "You are signed out" })).toBeVisible();
  await expect(page.getByText("Shauth ended the shared sign-in session")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with Shauth" })).toHaveAttribute(
    "href",
    "/login/shauth",
  );
  await expect(page.getByRole("link", { name: "Other sign-in options" })).toHaveAttribute(
    "href",
    "/login",
  );

  // The relying-party return is a stable, app-owned state. Reloading must not
  // silently re-enter OpenID Connect or depend on transient client state.
  await page.reload();
  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.getByRole("heading", { name: "You are signed out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with Shauth" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Shauth signed-out control is readable in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/signed-out");

    const styles = await page
      .getByRole("link", { name: "Sign in with Shauth" })
      .evaluate((node) => {
        const computed = getComputedStyle(node);
        return { background: computed.backgroundColor, color: computed.color };
      });
    expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(contrastRatio(styles.color, styles.background)).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByRole("link", { name: "Sign in with Shauth" })).toBeVisible();
  });
}

test("an unconfigured Shauth catalog launch fails closed on the local login page", async ({
  page,
}) => {
  await page.goto("/login/shauth");

  await expect(page).toHaveURL(/\/login\?error=Configuration$/);
  await expect(page.locator(sel(TESTID.loginSubmit))).toBeVisible();
});
