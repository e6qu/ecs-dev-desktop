// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";

import { chromium } from "@playwright/test";

const applicationOrigin = "http://localhost:3211";
const providerOrigin = "http://127.0.0.1:8080";
const password = process.env.SHAUTH_BOOTSTRAP_ADMIN_PASSWORD;
const validatorProbePassword = process.env.EDD_VALIDATOR_PROBE_PASSWORD;
const expectedBuildSha = process.env.EDD_BUILD_SHA;
const expectedBuildTime = process.env.EDD_BUILD_TIME;

assert.ok(password, "SHAUTH_BOOTSTRAP_ADMIN_PASSWORD is required");
assert.ok(validatorProbePassword, "EDD_VALIDATOR_PROBE_PASSWORD is required");
assert.ok(expectedBuildSha, "EDD_BUILD_SHA is required");
assert.ok(expectedBuildTime, "EDD_BUILD_TIME is required");

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

  // Release validators authenticate only to Shauth. EDD must not accept or
  // receive those credentials as an application session: protected APIs stay
  // closed and protected pages enter the ordinary OpenID Connect flow.
  const validatorAuthorization = `Basic ${Buffer.from(
    `validator:${validatorProbePassword}`,
    "utf8",
  ).toString("base64")}`;
  const rejectedApplicationCredentials = [
    { name: "Basic", headers: { authorization: validatorAuthorization } },
    {
      name: "bearer API key",
      headers: { authorization: `Bearer ${validatorProbePassword}` },
    },
    {
      name: "development identity headers",
      headers: { "x-edd-user-id": "validator", "x-edd-role": "admin" },
    },
    {
      name: "development identity cookies",
      headers: { cookie: "edd-dev-user=validator; edd-dev-role=admin" },
    },
  ];
  for (const candidate of rejectedApplicationCredentials) {
    const response = await context.request.get(`${applicationOrigin}/api/workspaces`, {
      headers: candidate.headers,
      maxRedirects: 0,
    });
    assert.equal(
      response.status(),
      401,
      `EDD accepted Shauth validator credentials through ${candidate.name}: ${await response.text()}`,
    );
  }
  const validatorPage = await context.request.get(`${applicationOrigin}/workspaces`, {
    headers: { authorization: validatorAuthorization },
    maxRedirects: 0,
  });
  assert.equal(validatorPage.status(), 200);
  const validatorPageBody = await validatorPage.text();
  assert.doesNotMatch(
    validatorPageBody,
    />Your workspaces</,
    "validator credentials rendered the authenticated workspace UI",
  );
  assert.match(
    validatorPageBody,
    /\/login\/shauth/,
    "validator credentials did not leave the signed-out page on the Shauth OpenID Connect path",
  );

  await page.goto(`${applicationOrigin}/login`);
  await page.locator('input[name="email"]').fill("validator@shauth.invalid");
  await page.locator('input[name="password"]').fill(validatorProbePassword);
  await page.getByRole("button", { name: "Continue with EDD account", exact: true }).click();
  await page.waitForURL((url) => url.origin === applicationOrigin && url.pathname === "/login");
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);

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
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();

  // Shauth's deployment-neutral validator can distinguish immutable releases
  // from the app-owned health contract without knowing where EDD is deployed.
  const healthResponse = await context.request.get(`${applicationOrigin}/api/healthz`);
  assert.equal(healthResponse.status(), 200);
  const health = await healthResponse.json();
  assert.equal(health.deploy?.sha, expectedBuildSha);
  assert.equal(health.deploy?.time, expectedBuildTime);

  // Keep the real Shauth browser session while removing only the relying
  // party's host-scoped cookies. Direct entry must silently establish a fresh
  // local session without another credential form.
  await context.clearCookies({ domain: "localhost" });
  await page.goto(`${applicationOrigin}/workspaces`);
  await waitForApplication(page, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "Your workspaces" }).waitFor();
  assert.equal(
    await page.locator("#password").count(),
    0,
    "direct SSO requested credentials again",
  );

  // Catalog entry is an independent launch path and must have the same silent
  // SSO behaviour as direct entry.
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
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await waitForURL(page, `${applicationOrigin}/signed-out`, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "You are signed out" }).waitFor();
  const shauthSignIn = page.getByRole("link", { name: "Sign in with Shauth", exact: true });
  assert.equal(await shauthSignIn.getAttribute("href"), "/login/shauth");
  await page.reload();
  await waitForURL(page, `${applicationOrigin}/signed-out`, navigationTrace, browserErrors);
  await page.getByRole("heading", { name: "You are signed out" }).waitFor();
  await page.getByRole("link", { name: "Sign in with Shauth", exact: true }).click();
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
  const revokedApi = await context.request.get(`${applicationOrigin}/api/workspaces`);
  assert.equal(
    revokedApi.status(),
    401,
    `provider logout left protected API open: ${await revokedApi.text()}`,
  );
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
