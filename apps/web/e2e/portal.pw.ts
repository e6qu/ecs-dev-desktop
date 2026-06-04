// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "../lib/constants";

// Must match `playwright.config.ts`. Cookies are set by `url` (not `domain`):
// a Domain attribute is invalid for an IP literal, so these must be host-only.
const BASE_URL = "http://127.0.0.1:3210";
const NODE_IMAGE = "golden/node:20";
const GO_IMAGE = "golden/go:1.22";
const adminCookieHeader = `${DEV_USER_COOKIE}=root; ${DEV_ROLE_COOKIE}=admin`;

/** Sign in by setting the dev-auth cookies the browser carries (EDD_DEV_AUTH=1). */
async function loginAs(context: BrowserContext, id: string, role: string): Promise<void> {
  await context.addCookies([
    { name: DEV_USER_COOKIE, value: id, url: BASE_URL },
    { name: DEV_ROLE_COOKIE, value: role, url: BASE_URL },
  ]);
}

test.beforeAll(async ({ request }) => {
  // Seed one enabled catalog entry so the member can launch a workspace.
  const res = await request.post("/api/base-images", {
    headers: { cookie: adminCookieHeader },
    data: { name: "Node 20", image: NODE_IMAGE },
  });
  expect(res.ok(), `seed catalog: ${res.status().toString()}`).toBeTruthy();
});

test("admin manages the base-image catalog", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/base-images");

  await expect(page.getByRole("heading", { name: "Base images" })).toBeVisible();
  // The seeded entry is listed.
  await expect(page.getByText(NODE_IMAGE)).toBeVisible();

  // Add a new entry through the form.
  await page.getByPlaceholder(/display name/).fill("Go 1.22");
  await page.getByPlaceholder(/image ref/).fill(GO_IMAGE);
  await page.getByRole("button", { name: "+ add base image" }).click();

  const goCard = page.locator(".card").filter({ hasText: GO_IMAGE });
  await expect(goCard).toBeVisible();
  await expect(goCard.getByText("enabled")).toBeVisible();

  // Disable it.
  await goCard.getByRole("button", { name: "disable" }).click();
  await expect(goCard.getByText("disabled")).toBeVisible();
});

test("member creates, stops, and deletes a workspace from the catalog", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  await loginAs(context, "alice", "member");
  await page.goto("/workspaces");

  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();

  // Launch from the catalog picker.
  await page.locator("select.select").selectOption(NODE_IMAGE);
  await page.getByRole("button", { name: "+ new workspace" }).click();

  const card = page.locator(".card").filter({ hasText: NODE_IMAGE }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("running")).toBeVisible();

  // Stop, then delete it.
  await card.getByRole("button", { name: "stop" }).click();
  await expect(card.getByText("stopped")).toBeVisible();

  await card.getByRole("button", { name: "delete" }).click();
  await expect(page.locator(".card").filter({ hasText: NODE_IMAGE })).toHaveCount(0);
});

test("admin sees the system health board with a live DynamoDB check", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin/health");

  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  // The live DynamoDB ping resolves ok (the table was created in global-setup).
  const dbRow = page.locator(".health-row").filter({ hasText: "dynamodb" });
  await expect(dbRow).toBeVisible();
  await expect(dbRow.getByText("ok")).toBeVisible();
  // Reconciler is unknown locally (CloudWatch on AWS).
  await expect(
    page.locator(".health-row").filter({ hasText: "reconciler" }).getByText("unknown"),
  ).toBeVisible();
});

test("non-admins are denied the admin console", async ({ page, context }) => {
  await loginAs(context, "alice", "member");
  await page.goto("/admin/health");
  await expect(page.getByText("Admins only")).toBeVisible();
  await expect(page.getByRole("heading", { name: "System health" })).toHaveCount(0);
});

test("admin inspects a workspace's detail and timeline", async ({ page, context, request }) => {
  // A member-owned workspace to inspect (left in place for the admin to open).
  const res = await request.post("/api/workspaces", {
    headers: { cookie: `${DEV_USER_COOKIE}=carol; ${DEV_ROLE_COOKIE}=member` },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();
  const ws = (await res.json()) as { id: string };

  await loginAs(context, "root", "admin");
  await page.goto("/admin/workspaces");
  await expect(page.getByRole("heading", { name: "All workspaces" })).toBeVisible();

  await page.getByText(ws.id).click();
  await expect(page.getByRole("heading", { name: "Inspect" })).toBeVisible();
  await expect(page.getByText("base image")).toBeVisible(); // a detail row
  await expect(page.locator(".tl-row").filter({ hasText: "created" })).toBeVisible(); // timeline
});

test("admin overview shows fleet and catalog stats", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin"); // redirects to /admin/overview

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".stat").filter({ hasText: "workspaces" })).toBeVisible();
  // The seeded catalog means ≥1 base image is reported.
  const images = page.locator(".stat").filter({ hasText: "base images" });
  await expect(images).toBeVisible();
  await expect(images.locator(".num")).not.toHaveText("0");
});
