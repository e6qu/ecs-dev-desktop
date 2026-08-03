// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";

import { chromium } from "@playwright/test";

const applicationOrigin = requiredOrigin("AUTH_URL");
const providerOrigin = requiredOrigin("AUTH_SHAUTH_ISSUER");
const password = process.env.SHAUTH_BOOTSTRAP_ADMIN_PASSWORD;
const validatorProbePassword = process.env.EDD_VALIDATOR_PROBE_PASSWORD;
const expectedBuildSha = process.env.EDD_BUILD_SHA;
const expectedBuildTime = process.env.EDD_BUILD_TIME;

/**
 * How long provider-initiated logout has to close this application's session.
 * The provider dispatches Back-Channel Logout without waiting for relying
 * parties, so this bounds an inherently asynchronous step. Ten seconds is far
 * beyond the ~100ms it actually takes, and far below any window in which a
 * still-open session would be acceptable.
 */
const PROVIDER_LOGOUT_REVOCATION_MS = 10_000;

assert.ok(password, "SHAUTH_BOOTSTRAP_ADMIN_PASSWORD is required");
assert.ok(validatorProbePassword, "EDD_VALIDATOR_PROBE_PASSWORD is required");
assert.ok(expectedBuildSha, "EDD_BUILD_SHA is required");
assert.ok(expectedBuildTime, "EDD_BUILD_TIME is required");

function requiredOrigin(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return new URL(value).origin;
}

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
  const anonymousValidation = await context.request.get(`${applicationOrigin}/auth/validation`, {
    maxRedirects: 0,
  });
  assert.equal(anonymousValidation.status(), 307);
  assert.equal(
    new URL(anonymousValidation.headers().location, applicationOrigin).pathname,
    "/signed-out",
  );

  // Where Shauth is the identity provider it is the only way in: the person has
  // already authenticated to it, so offering this application's own password
  // form as well would ask them to authenticate twice and would leave a second
  // credential path Shauth never sees. The form must therefore not exist, which
  // is a stronger guarantee than a form that rejects the validator's password.
  await page.goto(`${applicationOrigin}/login`);
  assert.equal(await page.locator('input[name="email"]').count(), 0);
  assert.equal(await page.locator('input[name="password"]').count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Continue with EDD account", exact: true }).count(),
    0,
  );
  const advertisedProviders = await (
    await context.request.get(`${applicationOrigin}/api/auth/providers`)
  ).json();
  assert.ok(
    advertisedProviders.credentials === undefined,
    "EDD advertised a local credential provider while Shauth is configured",
  );
  assert.ok(advertisedProviders.shauth !== undefined, "EDD did not advertise the Shauth provider");
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
  await page.getByRole("heading", { level: 1, name: "admin", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();

  await page.goto(`${applicationOrigin}/auth/validation`);
  await page.getByRole("heading", { name: "ECS Dev Desktop is authenticated" }).waitFor();
  assert.equal(await page.getByTestId("validation-username").textContent(), "admin");
  assert.equal(await page.getByTestId("validation-email").textContent(), "admin@localhost.test");
  assert.equal(await page.getByTestId("validation-role").textContent(), "admin");
  assert.equal(await page.getByTestId("validation-release").textContent(), expectedBuildSha);
  await page.locator("#main").getByRole("button", { name: "Sign out", exact: true }).waitFor();

  // Shauth's deployment-neutral validator can distinguish immutable releases
  // from the app-owned health contract without knowing where EDD is deployed.
  const healthResponse = await context.request.get(`${applicationOrigin}/api/healthz`);
  assert.equal(healthResponse.status(), 200);
  const health = await healthResponse.json();
  assert.equal(health.deploy?.sha, expectedBuildSha);
  assert.equal(health.deploy?.time, expectedBuildTime);

  // Logout from a direct application entry revokes the shared Shauth session
  // and finishes on EDD's own signed-out UI.
  await assertApplicationLogout(page, navigationTrace, browserErrors);

  // The application bridge accepts no caller-controlled completion state. A
  // replay after the one-time cookie was consumed, with or without redirect
  // injection fields, finishes safely on Shauth's own signed-out page.
  const bridge = `${applicationOrigin}/auth/shauth/logout/complete`;
  await page.goto(
    `${bridge}?post_logout_redirect_uri=https%3A%2F%2Fattacker.invalid%2F&return_to=%2Fadmin#ignored`,
  );
  await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/signed-out");
  assert.equal(new URL(page.url()).search, "");
  await page.goto(`${bridge}?destination=https%3A%2F%2Fattacker.invalid%2F`);
  await waitForURL(page, `${providerOrigin}/signed-out`, navigationTrace, browserErrors);

  // Re-authenticate through EDD before checking silent SSO for both direct and
  // catalog entry. The credential form belongs only to Shauth.
  await page.goto(`${applicationOrigin}/signed-out`);
  await page.getByRole("link", { name: "Sign in with Shauth", exact: true }).click();
  await page.waitForURL((url) => url.origin === providerOrigin && url.pathname === "/login");
  await page.locator("#username").fill("admin");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await waitForApplication(page, navigationTrace, browserErrors);

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

  // Logout after a catalog launch has the same app-local landing and global
  // session revocation contract as logout after direct entry.
  await assertApplicationLogout(page, navigationTrace, browserErrors);
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
  await page.getByRole("button", { name: "Sign out of all apps", exact: true }).click();
  await waitForURL(page, `${providerOrigin}/signed-out`, navigationTrace, browserErrors);
  // Back-Channel Logout is asynchronous by specification: the provider posts a
  // logout token to every relying party and returns the browser without waiting
  // for any of them to answer. Reaching the signed-out page therefore does not
  // prove this application has consumed its token yet, and asserting at that
  // exact instant is a race — one this application loses by roughly a tenth of a
  // second on a slower machine while winning it on CI. Still require the
  // revocation; require it within a stated window instead of instantly.
  const revoked = await revokedWithin(
    context,
    `${applicationOrigin}/api/workspaces`,
    PROVIDER_LOGOUT_REVOCATION_MS,
  );
  assert.equal(
    revoked.status,
    401,
    `provider logout left protected API open for ${PROVIDER_LOGOUT_REVOCATION_MS}ms: ${revoked.body}`,
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

/**
 * Polls a protected endpoint until it answers 401, or the deadline passes.
 * Returns the LAST response either way, so a failure reports what the endpoint
 * was still serving rather than only that it timed out.
 */
async function revokedWithin(context, url, deadlineMs) {
  const started = Date.now();
  for (;;) {
    const response = await context.request.get(url);
    if (response.status() === 401) return { status: 401, body: "" };
    if (Date.now() - started >= deadlineMs) {
      return { status: response.status(), body: await response.text() };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForApplication(page, trace, errors) {
  await waitForURL(page, `${applicationOrigin}/workspaces`, trace, errors);
}

async function assertApplicationLogout(page, trace, errors) {
  const pagePath = new URL(page.url()).pathname;
  const signOut =
    pagePath === "/auth/validation"
      ? page.getByRole("main").getByRole("button", { name: "Sign out", exact: true })
      : page.getByRole("banner").getByRole("button", { name: "Sign out", exact: true });
  await signOut.click();
  await waitForURL(page, `${applicationOrigin}/signed-out`, trace, errors);
  await page.getByRole("heading", { name: "You are signed out" }).waitFor();
  const signIn = page.getByRole("link", { name: "Sign in with Shauth", exact: true });
  assert.equal(await signIn.getAttribute("href"), "/login/shauth");
  await page.reload();
  await waitForURL(page, `${applicationOrigin}/signed-out`, trace, errors);
  await page.getByRole("heading", { name: "You are signed out" }).waitFor();
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
