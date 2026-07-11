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
  await expect(panel.locator("xpath=ancestor::body")).toBeVisible();
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

test("a lost control-plane connection exposes a top-level refresh control and recovers", async ({
  page,
  context,
}) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/workspaces");

  const refresh = page.locator(sel(TESTID.connectionRefresh));
  await expect(refresh).toBeHidden();
  await context.setOffline(true);
  await expect(refresh).toBeVisible();
  await expect(refresh).toHaveText(/connection lost.*refresh/i);
  await expect(refresh.locator("xpath=ancestor::header")).toHaveClass(/topbar/);

  await context.setOffline(false);
  await expect(refresh).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
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

  // Per-editor resource defaults: the form pre-selects the recommended CPU/RAM for the
  // chosen interface (heavy editors above the old flat 0.5 vCPU / 2 GiB) and the hint
  // re-recommends when the editor changes.
  const resourceHint = page.locator(sel(TESTID.sessionResourceHint));
  await expect(resourceHint).toContainText("Recommended for openvscode: 1 vCPU / 4 GiB");
  await page.locator(sel(TESTID.sessionEditor)).selectOption("terminal");
  await expect(resourceHint).toContainText("Recommended for terminal: 0.5 vCPU / 2 GiB");
  await expect(page.getByLabel("workspace CPU")).toHaveValue("512");
  await page.locator(sel(TESTID.sessionEditor)).selectOption("openvscode");
  await expect(page.getByLabel("workspace CPU")).toHaveValue("1024");
  await expect(page.getByLabel("workspace RAM")).toHaveValue("4096");

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
        const topbar = document.querySelector(".topbar");
        if (overlay === null || topbar === null || overlay.parentElement !== document.body)
          return false;
        return Number(getComputedStyle(overlay).zIndex) > Number(getComputedStyle(topbar).zIndex);
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      infoPanel.evaluate((el) => {
        const overlay = el.parentElement;
        return overlay === null ? "" : getComputedStyle(overlay).position;
      }),
    )
    .toBe("fixed");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("edd:modal-open", { detail: "page-help" }));
  });
  await expect(infoPanel).toBeHidden();
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

test("an empty workspace list converges when a workspace is created out-of-band", async ({
  page,
  context,
  request,
}) => {
  // A user with NO workspaces still gets live refresh (AGENTS.md rule 13): a
  // workspace created out-of-band must appear without any reload.
  await loginAs(context, "frank", "developer");
  await page.goto("/workspaces");
  await expect(page.locator(sel(TESTID.workspaceCard))).toHaveCount(0);

  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("frank", "developer") },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();

  // No page.reload(): the always-mounted LiveRefresh must surface the new card.
  await expect(page.locator(sel(TESTID.workspaceCard)).first()).toBeVisible({ timeout: 15_000 });
});

test("a viewer persona sees a read-only workspace list (no lifecycle buttons)", async ({
  page,
  context,
  request,
}) => {
  // The workspace exists (created while gina had developer rights)…
  const res = await request.post("/api/workspaces", {
    headers: { cookie: devCookieHeader("gina", "developer") },
    data: { baseImage: NODE_IMAGE },
  });
  expect(res.ok()).toBeTruthy();

  // …but viewed with the viewer role every mutating control must be absent —
  // the lifecycle POSTs would all 403, so the buttons must not render.
  await loginAs(context, "gina", "viewer");
  await page.goto("/workspaces");
  const card = page.locator(sel(TESTID.workspaceCard)).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "stop" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "delete" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "snapshot" })).toHaveCount(0);
  await expect(card.locator(sel(TESTID.workspacePurge))).toHaveCount(0);
  // The snapshot-interval editor collapses to its read-only meta line.
  await expect(card.getByRole("button", { name: "save" })).toHaveCount(0);

  // The same list under the developer role still offers the lifecycle actions.
  await loginAs(context, "gina", "developer");
  await page.goto("/workspaces");
  const devCard = page.locator(sel(TESTID.workspaceCard)).first();
  await expect(devCard).toBeVisible();
  await expect(devCard.getByRole("button", { name: "stop" })).toBeVisible();
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

test("admin sees the snapshot management console", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  // The nav exposes a Snapshots entry next to Images/Infrastructure.
  await page.goto("/admin/images");
  await page.getByRole("link", { name: "Snapshots" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/admin/snapshots`);
  await expect(page.getByRole("heading", { name: "Snapshots" })).toBeVisible();

  // The console mounts (bulk purge control is always present) and the table
  // converges to a concrete state (rows, or the empty-state note) with no load
  // error — never a silently blank table.
  await expect(page.getByTestId("admin-snapshot-purge-all")).toBeVisible();
  await expect(page.locator("table.data-table")).toBeVisible();
  // No LOAD-ERROR alert row inside the table (a failed list surfaces one, per §6.5).
  // Scope to the table so this ignores Next.js's always-present empty
  // <next-route-announcer role="alert"> a11y live region.
  await expect(page.locator("table.data-table").getByRole("alert")).toHaveCount(0);
});

test("non-admins are denied the snapshot console", async ({ page, context }) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/admin/snapshots");
  await expect(page.getByTestId(TESTID.adminDenied)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Snapshots" })).toHaveCount(0);
});

test("admin configures traffic filtering", async ({ page, context }) => {
  await loginAs(context, "root", "admin");
  // The nav exposes a Traffic entry next to Snapshots/Users.
  await page.goto("/admin/images");
  await page.getByRole("link", { name: "Traffic" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/admin/traffic`);
  await expect(page.getByRole("heading", { name: "Traffic filtering" })).toBeVisible();

  // The console loads without a load error (never a silently blank surface, §6.5) and
  // the cloud/hoster presets came through from the server.
  await expect(page.getByTestId("traffic-load-error")).toHaveCount(0);
  await expect(page.getByTestId("traffic-preset-aws")).toBeVisible();

  // Default (empty) policy is block mode → default action ALLOW, no compiled rules.
  await expect(page.getByTestId("traffic-default-action")).toHaveText("allow");
  await expect(page.getByTestId("traffic-preview-rule")).toHaveCount(0);

  // Set a country → a geo rule appears in the LIVE compiled preview (compiled by the
  // same @edd/core the server applies), with no save/WAF round-trip needed.
  await page.getByTestId("traffic-countries").fill("US");
  const geoRule = page.getByTestId("traffic-preview-rule").filter({ hasText: "US" });
  await expect(geoRule).toHaveCount(1);
  await expect(geoRule).toHaveAttribute("data-kind", "geo");
  await expect(geoRule).toHaveAttribute("data-action", "block");
});

test("non-admins are denied the traffic filter console", async ({ page, context }) => {
  await loginAs(context, "alice", "developer");
  await page.goto("/admin/traffic");
  await expect(page.getByTestId(TESTID.adminDenied)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Traffic filtering" })).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();

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
