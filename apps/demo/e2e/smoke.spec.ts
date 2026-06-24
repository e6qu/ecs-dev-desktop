// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

// Collect console errors + uncaught page errors for the duration of a test. A blank-screen crash
// (the bug this suite exists to prevent) shows up as a pageerror with an empty DOM.
function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test("renders and drives the core flows with no console errors", async ({ page }) => {
  const errors = captureErrors(page);

  await page.goto("/");
  await expect(page.locator(".demo-shell")).toBeVisible();
  // The seeded fleet renders (proves @edd/core ran in the browser, not a blank page).
  await expect(page.locator(".demo-ws").first()).toBeVisible();

  // Switch to the admin identity → the admin console appears.
  await page.locator(".demo-user select").selectOption("ada");
  await expect(page.getByRole("link", { name: "Costs" })).toBeVisible();

  // Costs: the real cost model over the seeded ledger renders spend bars. (toBeVisible auto-waits
  // for the route to render — count() would race the async navigation.)
  await page.getByRole("link", { name: "Costs" }).click();
  await expect(page.locator(".cost-bar").first()).toBeVisible();

  // Health + Infra derive from @edd/core.
  await page.getByRole("link", { name: "Health" }).click();
  await expect(page.locator(".h-badge").first()).toBeVisible();
  await page.getByRole("link", { name: "Infra" }).click();
  await expect(page.locator(".demo-topo-node").first()).toBeVisible();

  // Open a workspace IDE → editor + the agent panel mount.
  await page.getByRole("link", { name: "Workspaces" }).click();
  await page.locator(".demo-open").first().click();
  await expect(page.locator(".ide")).toBeVisible();
  await expect(page.locator(".agent-panel")).toBeVisible();
  // The scripted agent reveals output.
  await expect(page.locator(".agent-term-line").first()).toBeVisible();

  expect(errors, `unexpected console/page errors:\n${errors.join("\n")}`).toEqual([]);
});

test("auto-heals stale-schema persisted state instead of going blank", async ({ page }) => {
  const errors = captureErrors(page);

  // Seed the exact pre-agents blob that used to crash the app (version 1, no `agents` map).
  await page.addInitScript(() => {
    localStorage.setItem(
      "edd-demo:state:v1",
      JSON.stringify({
        version: 1,
        users: [],
        currentUserId: "x",
        catalog: [],
        workspaces: [],
        audit: [],
      }),
    );
  });

  await page.goto("/");
  // It discards the stale blob, re-seeds, and renders a populated fleet — no blank screen.
  await expect(page.locator(".demo-shell")).toBeVisible();
  await expect(page.locator(".demo-ws").first()).toBeVisible();
  expect(errors, `unexpected errors on stale-state load:\n${errors.join("\n")}`).toEqual([]);
});
