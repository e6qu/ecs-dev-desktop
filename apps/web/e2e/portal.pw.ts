// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { TESTID } from "../lib/testids";
import { devCookieHeader, loginAs as loginAsAt, sel } from "./support";

// Must match `playwright.config.ts`.
const BASE_URL = "http://127.0.0.1:3210";
const NODE_IMAGE = "golden/node:20";
const GO_IMAGE = "golden/go:1.22";
const adminCookieHeader = devCookieHeader("root", "admin");

const loginAs = (context: BrowserContext, id: string, role: string): Promise<void> =>
  loginAsAt(context, BASE_URL, id, role);

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
  // The seeded entry is listed (located by image, not by matching its text).
  await expect(page.locator(sel(TESTID.catalogCard, { "data-image": NODE_IMAGE }))).toBeVisible();

  // Add a new entry through the form.
  await page.getByPlaceholder(/display name/).fill("Go 1.22");
  await page.getByPlaceholder(/image ref/).fill(GO_IMAGE);
  await page.getByRole("button", { name: "+ add base image" }).click();

  const goCard = page.locator(sel(TESTID.catalogCard, { "data-image": GO_IMAGE }));
  await expect(goCard).toBeVisible();
  await expect(goCard).toHaveAttribute("data-enabled", "true");

  // Disable it.
  await goCard.getByRole("button", { name: "disable" }).click();
  await expect(goCard).toHaveAttribute("data-enabled", "false");
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

  const card = page.locator(sel(TESTID.workspaceCard, { "data-image": NODE_IMAGE })).first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "running");

  // Stop, then delete it.
  await card.getByRole("button", { name: "stop" }).click();
  await expect(card).toHaveAttribute("data-status", "stopped");

  await card.getByRole("button", { name: "delete" }).click();
  await expect(page.locator(sel(TESTID.workspaceCard, { "data-image": NODE_IMAGE }))).toHaveCount(
    0,
  );
});

test("admin sees the system health board with a live DynamoDB check", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin/health");

  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  // The live DynamoDB ping resolves ok (the table was created in global-setup).
  const dbRow = page.locator(sel(TESTID.healthRow, { "data-component": "dynamodb" }));
  await expect(dbRow).toBeVisible();
  await expect(dbRow).toHaveAttribute("data-h", "ok");
  // Reconciler is unknown locally (CloudWatch on AWS).
  await expect(
    page.locator(sel(TESTID.healthRow, { "data-component": "reconciler" })),
  ).toHaveAttribute("data-h", "unknown");
});

test("non-admins are denied the admin console", async ({ page, context }) => {
  await loginAs(context, "alice", "member");
  await page.goto("/admin/health");
  await expect(page.getByTestId(TESTID.adminDenied)).toBeVisible();
  await expect(page.getByRole("heading", { name: "System health" })).toHaveCount(0);
});

test("admin inspects a workspace's detail and timeline", async ({ page, context, request }) => {
  // A member-owned workspace to inspect (left in place for the admin to open).
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("carol", "member") },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();
  const ws = (await res.json()) as { id: string };

  await loginAs(context, "root", "admin");
  await page.goto("/admin/workspaces");
  await expect(page.getByRole("heading", { name: "All workspaces" })).toBeVisible();

  await page.locator(sel(TESTID.workspaceRow, { "data-id": ws.id })).click();
  await expect(page.getByRole("heading", { name: "Inspect" })).toBeVisible();
  // The derived lifecycle timeline shows the created event.
  await expect(page.locator(sel(TESTID.timelineRow, { "data-event": "created" }))).toBeVisible();
});

test("admin overview shows fleet and catalog stats", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin"); // redirects to /admin/overview

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(sel(TESTID.statTile, { "data-stat": "workspaces" }))).toBeVisible();
  // The seeded catalog means ≥1 base image is reported.
  await expect(
    page.locator(sel(TESTID.statTile, { "data-stat": "base images" })),
  ).not.toHaveAttribute("data-value", "0");
});

test("admin quotas page shows per-role limits and usage", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin/quotas");
  await expect(page.getByRole("heading", { name: "Quotas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Limits" })).toBeVisible();
  await expect(page.locator(sel(TESTID.quotaRow, { "data-role": "member" }))).toBeVisible();
});

test("admin costs page prices fleet spend per session and per user", async ({
  page,
  context,
  request,
}) => {
  // A member-owned workspace gives the cost report a priced session to render.
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("erin", "member") },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();
  const ws = (await res.json()) as { id: string };

  await loginAs(context, "root", "admin");
  await page.goto("/admin/costs");
  await expect(page.getByRole("heading", { name: "Costs" })).toBeVisible();

  // The fleet total tile renders.
  await expect(page.locator(sel(TESTID.costTile, { "data-cost": "total" }))).toBeVisible();
  // The just-created session is a cost line attributed to its owner.
  const row = page.locator(sel(TESTID.costSessionRow, { "data-id": ws.id }));
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-owner", "erin");
  // …and erin is rolled up in the per-user view.
  await expect(page.locator(sel(TESTID.costUserRow, { "data-owner": "erin" }))).toBeVisible();
});

test("admin logs page shows the derived audit feed and the CloudWatch streams", async ({
  page,
  context,
  request,
}) => {
  // A workspace gives the derived audit feed at least one event to render.
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("dan", "member") },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();

  await loginAs(context, "root", "admin");
  await page.goto("/admin/logs");
  await expect(page.getByRole("heading", { name: "Logs & audit" })).toBeVisible();

  // Derived audit feed renders a created event.
  await expect(
    page.locator(sel(TESTID.auditRow, { "data-action": "workspace.created" })).first(),
  ).toBeVisible();

  // The control-plane stream is live; container logs are marked as AWS-only.
  await expect(
    page.locator(sel(TESTID.logStream, { "data-stream": "control-plane" })),
  ).toHaveAttribute("data-available", "true");
  await expect(page.locator(sel(TESTID.logStream, { "data-stream": "container" }))).toHaveAttribute(
    "data-available",
    "false",
  );
});
