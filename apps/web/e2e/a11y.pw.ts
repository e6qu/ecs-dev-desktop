// SPDX-License-Identifier: AGPL-3.0-or-later
// Accessibility gate for the whole portal: every route is audited with axe-core
// against WCAG 2.2 AA (including colour contrast) in BOTH colour schemes, for the
// persona that can reach it. A single violation fails the run and prints the
// offending nodes, so a regression is caught where it is introduced rather than
// by a user with a screen reader or a high-contrast display.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { devCookieHeader, loginAs as loginAsAt } from "./support";

// Must match `playwright.config.ts`.
const BASE_URL = "http://127.0.0.1:3210";
// Distinct from the portal spec's seed: catalog entries are keyed by id, so a second entry
// for the same image would double the card the portal spec locates by image.
const IMAGE = "golden/node:20-a11y";
const adminCookieHeader = devCookieHeader("root", "admin");
const developerCookieHeader = devCookieHeader("a11y-dev", "developer");

/** The WCAG conformance level the portal commits to. `best-practice` is deliberately
 * excluded: it is advisory (landmark nesting, heading order heuristics) and not a
 * conformance requirement. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface Route {
  path: string;
  persona: "anonymous" | "developer" | "admin";
}

const STATIC_ROUTES: readonly Route[] = [
  { path: "/login", persona: "anonymous" },
  { path: "/login?error=invalid", persona: "anonymous" },
  { path: "/signed-out", persona: "anonymous" },
  { path: "/auth/error?error=Configuration", persona: "anonymous" },
  { path: "/invitation/not-a-real-token", persona: "anonymous" },
  { path: "/workspaces", persona: "developer" },
  { path: "/sessions/new", persona: "developer" },
  { path: "/base-images", persona: "developer" },
  { path: "/me", persona: "developer" },
  { path: "/settings/ssh-keys", persona: "developer" },
  { path: "/help/scale-to-zero", persona: "developer" },
  { path: "/auth/validation", persona: "developer" },
  { path: "/admin", persona: "developer" },
  { path: "/admin/overview", persona: "admin" },
  { path: "/admin/health", persona: "admin" },
  { path: "/admin/workspaces", persona: "admin" },
  { path: "/admin/catalog", persona: "admin" },
  { path: "/admin/images", persona: "admin" },
  { path: "/admin/infrastructure", persona: "admin" },
  { path: "/admin/snapshots", persona: "admin" },
  { path: "/admin/traffic", persona: "admin" },
  { path: "/admin/quotas", persona: "admin" },
  { path: "/admin/costs", persona: "admin" },
  { path: "/admin/logs", persona: "admin" },
  { path: "/admin/users", persona: "admin" },
  { path: "/admin/invitations", persona: "admin" },
];

let workspaceId = "";

test.beforeAll(async ({ request }) => {
  const seed = await request.post("/api/base-images", {
    headers: { cookie: adminCookieHeader },
    data: { name: "Node 20 (a11y)", image: IMAGE, tags: ["node"], tools: ["pnpm"] },
  });
  expect(seed.ok(), `seed catalog: ${seed.status().toString()}`).toBeTruthy();

  // Playwright restarts the worker (re-running this hook) after every failed test, so
  // reuse the persona's existing workspace rather than creating one per restart and
  // exhausting the developer quota mid-run.
  const listed = await request.get("/api/workspaces", {
    headers: { cookie: developerCookieHeader },
  });
  expect(listed.ok(), `list workspaces: ${listed.status().toString()}`).toBeTruthy();
  const existing = ((await listed.json()) as { workspaces: { id: string }[] }).workspaces;
  if (existing.length > 0) {
    workspaceId = existing[0].id;
    return;
  }
  const created = await request.post("/api/workspaces", {
    headers: { cookie: developerCookieHeader },
    data: { baseImage: IMAGE },
  });
  expect(
    created.ok(),
    `create workspace: ${created.status().toString()} ${await created.text()}`,
  ).toBeTruthy();
  workspaceId = ((await created.json()) as { id: string }).id;
});

async function signIn(page: Page, persona: Route["persona"]): Promise<void> {
  if (persona === "anonymous") return;
  const id = persona === "admin" ? "root" : "a11y-dev";
  await loginAsAt(page.context(), BASE_URL, id, persona);
}

async function auditPage(page: Page, path: string): Promise<void> {
  // Audit the SETTLED page: cards enter with a short fade, and axe sampling mid-fade
  // reads a blended (wrong) background colour for the text on them.
  // Only FINITE animations are awaited (a spinner/pulse never finishes), and one that
  // is cancelled mid-flight (its element left the DOM) counts as settled, not failed.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getTiming().iterations))
        .map((animation) =>
          animation.finished.then(
            () => undefined,
            () => undefined,
          ),
        ),
    ),
  );
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const report = results.violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `      ${n.target.join(" ")}\n        ${n.failureSummary ?? ""}`)
        .join("\n");
      return `  [${v.impact ?? "?"}] ${v.id}: ${v.help} (${v.helpUrl})\n${nodes}`;
    })
    .join("\n");
  // Assert on the rendered report (not the violation objects) so a failure prints
  // the rule, impact, and offending selectors instead of a multi-hundred-line diff.
  expect(report, path).toBe("");
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    for (const route of STATIC_ROUTES) {
      test(`${route.path} (${route.persona}) has no WCAG 2.2 AA violations`, async ({ page }) => {
        await signIn(page, route.persona);
        await page.goto(route.path);
        await expect(page.locator("main, [role=main]").first()).toBeVisible();
        await auditPage(page, route.path);
      });
    }

    for (const suffix of ["", "/monitoring", "/spectate"]) {
      test(`/workspaces/[id]${suffix} (developer) has no WCAG 2.2 AA violations`, async ({
        page,
      }) => {
        await signIn(page, "developer");
        await page.goto(`/workspaces/${workspaceId}${suffix}`);
        await expect(page.locator("main, [role=main]").first()).toBeVisible();
        await auditPage(page, `/workspaces/[id]${suffix}`);
      });
    }

    test(`/admin/workspaces/[id] (admin) has no WCAG 2.2 AA violations`, async ({ page }) => {
      await signIn(page, "admin");
      await page.goto(`/admin/workspaces/${workspaceId}`);
      await expect(page.locator("main, [role=main]").first()).toBeVisible();
      await auditPage(page, "/admin/workspaces/[id]");
    });
  });
}
