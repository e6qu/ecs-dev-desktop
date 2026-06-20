// SPDX-License-Identifier: AGPL-3.0-or-later
// LIVE portal browser e2e (playwright.live.config.ts): the UI drives REAL sim
// compute — every lifecycle click below launches/stops/hydrates an actual
// golden-image ECS task with managed EBS on the container-mode sockerless sim
// (COMPUTE_PROVIDER=ecs; cloud state from e2e/live-cloud-setup.ts).
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { listWorkspacesResponse, workspaceInspection } from "@edd/api-contracts";
import type { WorkspaceDetailDto } from "@edd/api-contracts";

import { TESTID } from "../lib/testids";
import { devCookieHeader, loginAs as loginAsAt, sel } from "./support";

// Must match `playwright.live.config.ts` / `live-cloud-setup.ts`.
const BASE_URL = "http://127.0.0.1:3220";
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const SUBNET_PREFIX = /^10\.73\.1\.\d+$/;

const loginAs = (context: BrowserContext, id: string, role: string): Promise<void> =>
  loginAsAt(context, BASE_URL, id, role);

const ADMIN_COOKIE = { cookie: devCookieHeader("root", "admin") };

/** The workspace's full persisted detail via the admin Inspect route. */
async function inspectByImage(
  request: APIRequestContext,
  image: string,
  owner: string,
): Promise<WorkspaceDetailDto> {
  const listRes = await request.get("/api/admin/workspaces", { headers: ADMIN_COOKIE });
  expect(listRes.ok()).toBeTruthy();
  const ws = listWorkspacesResponse
    .parse(await listRes.json())
    .workspaces.find((w) => w.baseImage === image && w.ownerId === owner);
  if (ws === undefined) throw new Error(`no workspace for ${owner}/${image} in admin list`);
  const inspectRes = await request.get(`/api/admin/workspaces/${ws.id}`, {
    headers: ADMIN_COOKIE,
  });
  expect(inspectRes.ok()).toBeTruthy();
  return workspaceInspection.parse(await inspectRes.json()).workspace;
}

test("member lifecycle in the browser acts on real ECS tasks (create → stop → wake → delete)", async ({
  page,
  context,
  request,
}) => {
  await loginAs(context, "live-member", "member");
  await page.goto("/sessions/new");
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

  // Launch from the catalog picker — blocks until the sim task's managed EBS
  // volume is attached, so the card appears with a real running task behind it.
  await page
    .locator(sel(TESTID.catalogPickerOption, { "data-image": WORKSPACE_IMAGE }))
    .first()
    .click();
  await page.getByRole("button", { name: "blank session" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/workspaces`);

  const card = page.locator(sel(TESTID.workspaceCard, { "data-image": WORKSPACE_IMAGE })).first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "running");

  // The bindings behind the card are real: ECS task ARN + an ENI address from
  // the live subnet (admin Inspect API, same server).
  const created = await inspectByImage(request, WORKSPACE_IMAGE, "live-member");
  expect(created.taskId).toMatch(/^arn:aws:ecs:/);
  expect(created.volumeId).toMatch(/^vol-/);
  expect(created.sshHost).toMatch(SUBNET_PREFIX);

  // Open editor: the in-app path-based proxy. The card's link points at /w/<id>/;
  // opening it (same Auth.js session) authorizes ownership in-process, hands the
  // browser the per-workspace connection token (?tkn=, derived from the same secret
  // the task's CONNECTION_TOKEN was), and proxies HTTP+WS to the real golden-image
  // OpenVSCode — which serves under --server-base-path /w/<id>/. The workbench
  // rendering proves the whole chain end to end (a wrong/absent token → 401, no
  // workbench). Opened in its own page so the lifecycle card stays put.
  const openLink = card.locator(sel(TESTID.workspaceOpen));
  await expect(openLink).toHaveAttribute("href", `/w/${created.id}/`);
  const editor = await context.newPage();
  await editor.goto(`${BASE_URL}/w/${created.id}/`);
  await expect(editor.locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
  await editor.close();

  // Stop: snapshot + real task teardown.
  await card.getByRole("button", { name: "stop" }).click();
  await expect(card).toHaveAttribute("data-status", "stopped");

  // Start: a NEW task hydrated from the stop snapshot.
  await card.getByRole("button", { name: "start" }).click();
  await expect(card).toHaveAttribute("data-status", "running");

  const woken = await inspectByImage(request, WORKSPACE_IMAGE, "live-member");
  expect(woken.id).toBe(created.id);
  expect(woken.taskId).toMatch(/^arn:aws:ecs:/);
  expect(woken.taskId).not.toBe(created.taskId);
  expect(woken.latestSnapshotId).toMatch(/^snap-/);

  // Delete takes a two-step confirm (it destroys the EBS volume/snapshot). It is then
  // async: the workspace moves to the `deleting` tombstone (the reconciler converges
  // teardown of the task/volume and removes the record), so the card transitions to
  // `deleting` (no further actions) rather than vanishing instantly.
  await card.getByRole("button", { name: "delete" }).click();
  await card.getByRole("button", { name: /confirm delete/ }).click();
  await expect(card).toHaveAttribute("data-status", "deleting");
});
