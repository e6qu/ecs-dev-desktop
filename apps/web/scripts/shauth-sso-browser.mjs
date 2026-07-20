// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";

import { chromium } from "@playwright/test";

const applicationOrigin = "http://localhost:3211";
const providerOrigin = "http://127.0.0.1:8080";
const password = process.env.SHAUTH_BOOTSTRAP_ADMIN_PASSWORD;

assert.ok(password, "SHAUTH_BOOTSTRAP_ADMIN_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserErrors = [];
  const navigationTrace = [];

  page.on("request", (request) => {
    if (request.isNavigationRequest()) {
      navigationTrace.push(`request ${request.method()} ${sanitizeURL(request.url())}`);
    }
  });
  page.on("response", (response) => {
    if (response.request().isNavigationRequest()) {
      navigationTrace.push(`response ${response.status()} ${sanitizeURL(response.url())}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  // The catalog coordinate is the canonical application root. A browser with
  // no EDD session enters Shauth automatically and never renders an anonymous
  // workspace shell.
  await page.goto(`${applicationOrigin}/`);
  await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/login");
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await waitForApplication(page, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "Your workspaces" }).waitFor();
  await page.goto(`${applicationOrigin}/me`);
  await page.locator("h1").waitFor();
  await page.getByText("admin@localhost.test").waitFor();
  await page.locator("#main").getByText("admin", { exact: true }).waitFor();

  // Keep the real Shauth browser session while removing only the relying
  // party's host-scoped cookies. Opening EDD from the provider catalog must
  // silently establish a fresh local session without another credential form.
  await context.clearCookies({ domain: "localhost" });
  await page.goto(`${providerOrigin}/apps`);
  await page.getByRole("link", { name: "Open ECS Dev Desktop" }).click();
  await waitForApplication(page, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "Your workspaces" }).waitFor();
  assert.equal(
    await page.locator("#password").count(),
    0,
    "catalog SSO requested credentials again",
  );

  // Relying-party initiated logout terminates the central Shauth session and
  // returns to the relying party's stable signed-out page.
  await page.getByRole("button", { name: "sign out" }).click();
  await waitForURL(page, `${applicationOrigin}/signed-out`, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "You are signed out" }).waitFor();
  await page.goto(`${applicationOrigin}/`);
  await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/login");
  await page.locator("#password").waitFor();

  // Establish another real EDD session, then initiate logout at Shauth itself.
  // The provider's back-channel token must revoke EDD's durable session even
  // though its Auth.js cookie remains in the browser.
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await waitForApplication(page, navigationTrace, browserErrors);
  await page.goto(`${providerOrigin}/logout`);
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Sign out everywhere" }).click(),
  ]);
  await page.goto(`${providerOrigin}/login`);
  await page.locator("#password").waitFor();
  await page.goto(`${applicationOrigin}/workspaces`);
  await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/login");
  await page.locator("#password").waitFor();

  assert.deepEqual(browserErrors, [], [...navigationTrace, ...browserErrors].join("\n"));
} finally {
  await browser.close();
}

function sanitizeURL(value) {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

async function waitForApplication(page, trace, errors) {
  await waitForURL(page, `${applicationOrigin}/workspaces`, trace, errors);
}

async function waitForURL(page, expected, trace, errors) {
  const deadline = Date.now() + 30_000;
  while (page.url() !== expected && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  assert.equal(
    page.url(),
    expected,
    [...trace, ...errors.map((error) => `browser error ${error}`)].join("\n"),
  );
}
