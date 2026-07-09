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
  // Seed one enabled catalog entry so the developer can launch a workspace.
  const res = await request.post("/api/base-images", {
    headers: { cookie: adminCookieHeader },
    data: {
      name: "Node 20",
      image: NODE_IMAGE,
      tags: ["typescript", "node"],
      tools: ["pnpm", "eslint"],
    },
  });
  expect(res.ok(), `seed catalog: ${res.status().toString()}`).toBeTruthy();
});

test("admin manages the base-image catalog", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin/catalog");

  await expect(page.getByRole("heading", { name: "Base images" })).toBeVisible();
  // The seeded entry is listed (located by image, not by matching its text).
  await expect(page.locator(sel(TESTID.catalogCard, { "data-image": NODE_IMAGE }))).toBeVisible();

  // Add a new entry through the form.
  await page.getByLabel(/display name/i).fill("Go 1.22");
  await page.getByLabel(/image ref/i).fill(GO_IMAGE);
  await page.getByLabel(/tags/i).fill("go, backend");
  await page.getByLabel(/tools/i).fill("go, golangci-lint");
  await page.getByRole("button", { name: "+ add base image" }).click();

  const goCard = page.locator(sel(TESTID.catalogCard, { "data-image": GO_IMAGE })).last();
  await expect(goCard).toBeVisible();
  await expect(goCard).toHaveAttribute("data-enabled", "true");
  await expect(goCard).toHaveAttribute("data-tags", "go,backend");
  await expect(goCard).toHaveAttribute("data-tools", "go,golangci-lint");

  // Disable it.
  await goCard.getByRole("button", { name: "disable" }).click();
  await expect(goCard).toHaveAttribute("data-enabled", "false");
});

test("legacy catalog route redirects into the admin console", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  await page.goto("/base-images");
  await expect(page).toHaveURL(`${BASE_URL}/admin/catalog`);
  await expect(page.getByRole("heading", { name: "Base images" })).toBeVisible();
});

test("page help opens as an overlay without changing document layout", async ({
  page,
  context,
}) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/workspaces");

  const before = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.locator(sel(TESTID.helpToggle)).click();
  const panel = page.locator(sel(TESTID.helpPanel));
  await expect(panel).toBeVisible();
  await expect(panel).toHaveJSProperty("tagName", "SECTION");
  await expect
    .poll(async () =>
      panel.evaluate((el) => {
        const overlay = el.parentElement;
        return overlay === null ? "" : getComputedStyle(overlay).position;
      }),
    )
    .toBe("fixed");
  const after = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(after).toBeLessThanOrEqual(before + 1);
});

test("developer chooses a session environment from the metadata picker", async ({
  page,
  context,
}) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/sessions/new");

  const option = page
    .locator(sel(TESTID.catalogPickerOption, { "data-image": NODE_IMAGE }))
    .first();
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute("data-selected", "true");
  await expect(option).toHaveAttribute("data-tags", "typescript,node");
  await expect(option).toHaveAttribute("data-tools", "pnpm,eslint");
});

test("developer creates, stops, and deletes a workspace from the catalog", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/sessions/new");

  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

  // Launch from the catalog picker: blank mode is the default; ONE Start button.
  await page
    .locator(sel(TESTID.catalogPickerOption, { "data-image": NODE_IMAGE }))
    .first()
    .click();
  await page.locator(sel(TESTID.sessionStart)).click();

  // Lands on the per-workspace live status page, which follows the boot.
  await expect(page).toHaveURL(new RegExp(`${BASE_URL}/workspaces/ws-`));
  const hero = page.locator(sel(TESTID.workspaceStatusHero));
  await expect(hero).toBeVisible();
  await expect(hero).toHaveAttribute("data-status", "running");

  // The rest of the lifecycle is exercised from the fleet list.
  await page.goto("/workspaces");
  const card = page.locator(sel(TESTID.workspaceCard, { "data-image": NODE_IMAGE })).first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "running");

  await card.locator(sel(TESTID.workspaceInfoToggle)).click();
  const infoPanel = page.locator(sel(TESTID.workspaceInfoPanel));
  await expect(infoPanel).toBeVisible();
  await expect
    .poll(async () =>
      infoPanel.evaluate((el) => {
        const overlay = el.parentElement;
        return overlay === null ? "" : getComputedStyle(overlay).position;
      }),
    )
    .toBe("fixed");
  await page.locator(sel(TESTID.workspaceInfoClose)).click();
  await expect(infoPanel).toBeHidden();

  // Stop, then delete it. Manual stop is now cancelable: the card first moves to
  // `stopping` (the session keeps running through a short grace), and a detached
  // converge snapshots + scales to zero → `stopped`. Allow for the grace + snapshot.
  await card.getByRole("button", { name: "stop" }).click();
  await expect(card).toHaveAttribute("data-status", "stopping");
  await expect(card).toHaveAttribute("data-status", "stopped", { timeout: 20_000 });

  // Delete takes a two-step confirm (it destroys the EBS volume/snapshot): the first
  // click arms it, the second confirms. Delete is then async — it tombstones the
  // workspace (state → `deleting`) and the reconciler converges teardown + removal, so
  // the card transitions to `deleting` rather than vanishing instantly.
  await card.getByRole("button", { name: "delete" }).click();
  await card.getByRole("button", { name: /confirm delete/ }).click();
  await expect(card).toHaveAttribute("data-status", "deleting");
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
  await loginAs(context, "alice", "developer");
  await page.goto("/admin/health");
  await expect(page.getByTestId(TESTID.adminDenied)).toBeVisible();
  await expect(page.getByRole("heading", { name: "System health" })).toHaveCount(0);
});

test("admin sees the infrastructure view: cluster, fleet, and topology", async ({
  page,
  context,
}) => {
  await loginAs(context, "root", "admin");
  await page.goto("/admin/infrastructure");

  await expect(page.getByRole("heading", { name: "Infrastructure", exact: true })).toBeVisible();

  // Cluster metric tiles render (local fake cluster reports zero tasks here).
  await expect(page.locator(sel(TESTID.clusterStat)).first()).toBeVisible();
  await expect(
    page.locator(sel(TESTID.clusterStat, { "data-metric": "running tasks" })),
  ).toBeVisible();

  // Topology lights up the core components with live health overlaid: the
  // DynamoDB node is ok (live ping), compute is present, and a known edge exists.
  await expect(page.locator(sel(TESTID.topologyNode, { "data-node": "dynamodb" }))).toHaveAttribute(
    "data-h",
    "ok",
  );
  await expect(page.locator(sel(TESTID.topologyNode, { "data-node": "compute" }))).toBeVisible();
  await expect(
    page.locator(sel(TESTID.topologyEdge, { "data-from": "compute", "data-to": "storage" })),
  ).toBeVisible();
});

test("non-admins are denied the infrastructure view", async ({ page, context }) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/admin/infrastructure");
  await expect(page.getByTestId(TESTID.adminDenied)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Infrastructure", exact: true })).toHaveCount(0);
});

test("admin inspects a workspace's detail and timeline", async ({ page, context, request }) => {
  // A developer-owned workspace to inspect (left in place for the admin to open).
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("carol", "developer") },
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
  await expect(page.locator(sel(TESTID.quotaRow, { "data-role": "developer" }))).toBeVisible();
});

test("admin costs page prices fleet spend per session and per user", async ({
  page,
  context,
  request,
}) => {
  // A developer-owned workspace gives the cost report a priced session to render.
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("erin", "developer") },
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

  // Each row renders a proportional spend bar scaled to the most-expensive line in
  // its list (width = totalUsd / maxUsd). erin's session row carries one, with a
  // rounded width percent in [0, 100]. We assert the percent, never absolute
  // dollars — the dollar figure grows with elapsed run time (AGENTS.md §6.10).
  // (Other specs share the fleet, so erin's row is not guaranteed to be the max;
  // the most-expensive session row, whichever it is, fills the bar at 100% below.)
  const sessionBar = row.locator(sel(TESTID.costBar));
  await expect(sessionBar).toBeVisible();
  const pct = Number(await sessionBar.getAttribute("data-pct"));
  expect(Number.isInteger(pct)).toBeTruthy();
  expect(pct).toBeGreaterThanOrEqual(0);
  expect(pct).toBeLessThanOrEqual(100);

  // The single most-expensive session (the list max) fills its bar exactly.
  await expect(
    page.locator(sel(TESTID.costSessionRow)).first().locator(sel(TESTID.costBar)),
  ).toHaveAttribute("data-pct", "100");

  // The time-window selector defaults to "All time" and scopes the report when
  // changed. The session was created just now, so it stays inside the 24h window.
  await expect(page.locator(sel(TESTID.costWindow, { "data-window": "all" }))).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.locator(sel(TESTID.costWindow, { "data-window": "1d" })).click();
  await expect(page).toHaveURL(/\?window=1d$/);
  await expect(page.locator(sel(TESTID.costWindow, { "data-window": "1d" }))).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.locator(sel(TESTID.costSessionRow, { "data-id": ws.id }))).toBeVisible();
});

test("admin logs page shows the derived audit feed and the CloudWatch streams", async ({
  page,
  context,
  request,
}) => {
  // A workspace gives the derived audit feed at least one event to render.
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("dan", "developer") },
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
