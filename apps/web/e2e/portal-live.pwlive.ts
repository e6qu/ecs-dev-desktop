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

  // Launch through the redesigned session launcher: pick the environment, keep
  // the default "blank" start mode, and press the single Start button — the
  // create call blocks until the sim task's managed EBS volume is attached, then
  // the launcher redirects to the workspace's live status page.
  await page
    .locator(sel(TESTID.catalogPickerOption, { "data-image": WORKSPACE_IMAGE }))
    .first()
    .click();
  await page.locator(sel(TESTID.sessionModeOption, { "data-mode": "blank" })).click();
  await page.locator(sel(TESTID.sessionStart)).click();
  await expect(page).toHaveURL(/\/workspaces\/ws-/);

  // The card (with its actions) lives on the workspaces grid.
  await page.goto("/workspaces");
  const card = page.locator(sel(TESTID.workspaceCard, { "data-image": WORKSPACE_IMAGE })).first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "running");

  // The bindings behind the card are real: ECS task ARN + an ENI address from
  // the live subnet (admin Inspect API, same server).
  const created = await inspectByImage(request, WORKSPACE_IMAGE, "live-member");
  expect(created.taskId).toMatch(/^arn:aws:ecs:/);
  expect(created.volumeId).toMatch(/^vol-/);
  expect(created.sshHost).toMatch(SUBNET_PREFIX);

  // The "Open editor" affordance points at the in-app path-based proxy (`/w/<id>/`)
  // for a running workspace. (The full browser→proxy→editor workbench reach is
  // exercised through the IDE bridge in `live-ide-flow.e2e.ts` and on real cloud:
  // the sim runs each task in an awsvpc netns the host can't route to, so the
  // host-process proxy can't reach the ENI here — that hop is the e2e-aws tier.)
  await expect(card.locator(sel(TESTID.workspaceOpen))).toHaveAttribute(
    "href",
    `/w/${created.id}/`,
  );

  // Stop: snapshot + real task teardown. Cancelable now — the card first shows
  // `stopping` (session still up through the grace), then the converge scales it to
  // zero. On real AWS the snapshot + StopTask take longer, so allow a wide window.
  await card.getByRole("button", { name: "stop" }).click();
  await expect(card).toHaveAttribute("data-status", "stopping");
  await expect(card).toHaveAttribute("data-status", "stopped", { timeout: 120_000 });

  // Resume: a stopped workspace now shows ONE button — "Resume" — which routes to
  // the per-workspace status page. That page wakes the workspace (a NEW task
  // hydrated from the stop snapshot), shows the load progress, and auto-opens the
  // editor when ready. We assert the wake through the admin inspect API and stop
  // short of following the auto-open into the proxied editor (the sim can't route
  // the awsvpc ENI — that hop is the e2e-aws tier).
  await card.getByTestId(TESTID.workspaceResume).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${created.id}`));
  await expect
    .poll(async () => (await inspectByImage(request, WORKSPACE_IMAGE, "live-member")).state, {
      timeout: 120_000,
    })
    .toBe("running");
  const woken = await inspectByImage(request, WORKSPACE_IMAGE, "live-member");
  expect(woken.id).toBe(created.id);
  expect(woken.taskId).toMatch(/^arn:aws:ecs:/);
  expect(woken.taskId).not.toBe(created.taskId);
  expect(woken.latestSnapshotId).toMatch(/^snap-/);

  // Delete via the API: the browser already drove create → stop → resume, and
  // deleting here avoids racing the status page's auto-open redirect (the delete
  // is a two-step confirm in the UI, but its transition is the same async
  // `deleting` tombstone the reconciler then converges).
  const deleteRes = await request.delete(`/api/workspaces/${created.id}`, {
    headers: { cookie: devCookieHeader("live-member", "member") },
  });
  expect(deleteRes.status()).toBe(202);
  await expect
    .poll(async () => (await inspectByImage(request, WORKSPACE_IMAGE, "live-member")).state, {
      timeout: 30_000,
    })
    .toBe("deleting");
});
