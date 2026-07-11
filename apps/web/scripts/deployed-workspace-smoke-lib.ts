// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { encode } from "next-auth/jwt";

import { AUTH_SESSION_SCHEMA_VERSION, createAuthSession } from "../lib/auth-sessions";

export type Editor = "openvscode" | "monaco" | "terminal" | "opencode";

export const EDITORS: readonly Editor[] = ["openvscode", "monaco", "terminal", "opencode"];
const SESSION_MAX_AGE_S = 4 * 60 * 60;
const AUTH_COOKIE_NAME = "__Secure-authjs.session-token";

export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function cookieNameForEditor(editor: Editor): string {
  switch (editor) {
    case "openvscode":
      return "vscode-tkn";
    case "monaco":
    case "terminal":
      return "edd-editor-token";
    case "opencode":
      return "opencode";
  }
}

function cookiePath(setCookie: string): string {
  for (const rawPart of setCookie.split(";").slice(1)) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).toLowerCase() === "path") return part.slice(eq + 1);
  }
  return "/";
}

function cookieHeader(jar: readonly StoredCookie[], url: string): string {
  const path = new URL(url).pathname;
  return jar
    .filter((cookie) => path.startsWith(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function hasCookie(jar: readonly StoredCookie[], url: string, name: string): boolean {
  const path = new URL(url).pathname;
  return jar.some((cookie) => cookie.name === name && path.startsWith(cookie.path));
}

function absorb(jar: StoredCookie[], res: Response): void {
  for (const setCookie of res.headers.getSetCookie()) {
    const pair = setCookie.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const path = cookiePath(setCookie);
    const existing = jar.findIndex((cookie) => cookie.name === name && cookie.path === path);
    if (existing !== -1) jar.splice(existing, 1);
    if (value.length > 0) jar.push({ name, value, path });
  }
}

async function fetchWithCookies(
  url: string,
  jar: readonly StoredCookie[],
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookieHeader(jar, url));
  return fetch(url, { ...init, headers, redirect: "manual" });
}

export async function authSecret(region: string, secretId: string): Promise<string> {
  const out = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (out.SecretString === undefined || out.SecretString.length === 0) {
    throw new Error(`${secretId} returned no SecretString`);
  }
  return out.SecretString;
}

export async function authJar(
  secret: string,
  ownerPrefix: string,
): Promise<{
  readonly jar: StoredCookie[];
  readonly sessionId: string;
}> {
  const owner = `${ownerPrefix}-${randomUUID()}`;
  const session = await createAuthSession({ ownerId: owner, role: "admin" });
  const token = await encode({
    secret,
    salt: AUTH_COOKIE_NAME,
    maxAge: SESSION_MAX_AGE_S,
    token: {
      uid: owner,
      email: `${owner}@smoke.edd.local`,
      role: "admin",
      authSessionId: session.id,
      authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
    },
  });
  return { jar: [{ name: AUTH_COOKIE_NAME, value: token, path: "/" }], sessionId: session.id };
}

export function chooseEnabledImage(images: readonly string[], expectedTag?: string): string {
  const expected = expectedTag?.trim();
  if (expected !== undefined && expected.length > 0) {
    const matching = images.find((image) => image.endsWith(`:${expected}`));
    if (matching === undefined) {
      throw new Error(
        `no enabled base image with expected tag ${expected}; enabled images: ${images.join(", ")}`,
      );
    }
    return matching;
  }
  if (images.length === 0) throw new Error("no enabled base image in deployed catalog");
  return images[0];
}

/**
 * Injectable time source for the polling loops, so tests never depend on real
 * multi-minute waits (AGENTS.md §6.10).
 */
export interface WaitClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Catalog rollout window when no matching image build is in flight. */
export const IMAGE_ROLLOUT_BASE_DEADLINE_MS = 4 * 60 * 1000;
/**
 * Hard cap on the total catalog rollout wait: golden builds take ~12 min, so
 * while a matching trigger reports an in-flight build the base window slides —
 * but never past this cap.
 */
export const IMAGE_ROLLOUT_HARD_CAP_MS = 30 * 60 * 1000;
const IMAGE_ROLLOUT_POLL_INTERVAL_MS = 5_000;
const READY_DEADLINE_MS = 8 * 60 * 1000;
const READY_POLL_INTERVAL_MS = 5_000;
const TERMINATED_DEADLINE_MS = 20 * 60 * 1000;
const TERMINATED_POLL_INTERVAL_MS = 10_000;
const PURGED_DEADLINE_MS = 2 * 60 * 1000;
const PURGED_POLL_INTERVAL_MS = 2_000;

/** Auth failures never self-heal, so polling through them only hides a contract bug. */
const AUTH_FAILURE_STATUSES: readonly number[] = [401, 403];

/**
 * Image-source trigger statuses that mean a build is legitimately in flight
 * (not yet succeeded, not terminally failed) — see `imageSourceTriggerStatus`
 * in @edd/api-contracts.
 */
const IN_FLIGHT_TRIGGER_STATUSES: readonly string[] = ["received", "queued", "building"];
const FAILED_TRIGGER_STATUSES: readonly string[] = ["failed", "error", "errored", "cancelled"];

interface ImageSourceTriggerView {
  readonly tag: string | undefined;
  readonly afterSha: string | undefined;
  readonly status: string;
}

/**
 * Extract the triggers array from the /api/admin/image-source payload. The
 * deployed route always serves an ImageSourceStateDto with a `triggers` array
 * (see @edd/api-contracts), so an unrecognizable payload or trigger entry is
 * contract drift — fail loudly instead of polling against a payload we cannot
 * interpret (same policy as `enabledCatalogImages`).
 */
function parseImageSourceTriggers(payload: unknown): readonly ImageSourceTriggerView[] {
  const shapeError = (): Error =>
    new Error(
      `image-source payload did not contain a recognizable triggers array: ${JSON.stringify(payload)}`,
    );
  if (typeof payload !== "object" || payload === null || !("triggers" in payload)) {
    throw shapeError();
  }
  const rawTriggers: unknown = payload.triggers;
  if (!Array.isArray(rawTriggers)) throw shapeError();
  return rawTriggers.map((raw: unknown): ImageSourceTriggerView => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("status" in raw) ||
      typeof raw.status !== "string"
    ) {
      throw new Error(
        `image-source trigger entry was not a recognizable trigger object: ${JSON.stringify(raw)}`,
      );
    }
    const tag = "tag" in raw && typeof raw.tag === "string" ? raw.tag : undefined;
    const afterSha =
      "afterSha" in raw && typeof raw.afterSha === "string" ? raw.afterSha : undefined;
    return { tag, afterSha, status: raw.status };
  });
}

function triggerMatchesTag(trigger: ImageSourceTriggerView, expectedTag: string): boolean {
  if (trigger.tag === expectedTag) return true;
  return trigger.afterSha?.startsWith(expectedTag) === true;
}

interface PollResult {
  readonly status: number;
  /** Parsed JSON body when the response was ok; absent on transient failures. */
  readonly body?: unknown;
}

/** 429 backs off and self-heals just like a gateway 5xx; every other 4xx is a contract bug. */
const RATE_LIMIT_STATUS = 429;
const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_FLOOR = 500;

/**
 * One authenticated GET in a polling loop. Transient failures — gateway 5xx
 * (an ALB serves 502/503/504 while a fresh deploy drains old tasks) and 429 —
 * are returned as status-only results so the caller keeps polling until its
 * deadline. 404 is also returned status-only because callers give it meaning
 * (terminated/purged treat it as success; ready polls through a create's
 * eventual-consistency window). Any other 4xx (400, 401, 403, 405, …) proves a
 * contract problem that will never self-heal — throw immediately.
 */
async function pollJson(
  baseUrl: string,
  jar: readonly StoredCookie[],
  path: string,
): Promise<PollResult> {
  const res = await fetchWithCookies(`${baseUrl}${path}`, jar);
  if (AUTH_FAILURE_STATUSES.includes(res.status)) {
    throw new Error(`${path} failed with ${String(res.status)} (auth will not self-heal)`);
  }
  if (res.ok) return { status: res.status, body: await res.json() };
  if (
    res.status === NOT_FOUND_STATUS ||
    res.status === RATE_LIMIT_STATUS ||
    res.status >= SERVER_ERROR_FLOOR
  ) {
    return { status: res.status };
  }
  throw new Error(
    `${path} failed with ${String(res.status)} (will not self-heal): ${await res.text()}`,
  );
}

export async function waitEnabledImage(
  baseUrl: string,
  jar: readonly StoredCookie[],
  expectedTag: string,
  onPoll?: (snapshot: {
    readonly enabledImages: readonly string[];
    readonly imageSource: unknown;
  }) => void,
  clock: WaitClock = REAL_CLOCK,
): Promise<string> {
  const start = clock.now();
  const hardDeadline = start + IMAGE_ROLLOUT_HARD_CAP_MS;
  let deadline = start + IMAGE_ROLLOUT_BASE_DEADLINE_MS;
  let lastImages: readonly string[] = [];
  let lastImageSource: unknown = null;
  let lastHttpStatus: number | undefined;
  while (clock.now() < deadline) {
    const source = await pollJson(baseUrl, jar, "/api/admin/image-source");
    lastHttpStatus = source.status;
    if ("body" in source) {
      lastImageSource = source.body;
      const triggers = parseImageSourceTriggers(source.body);
      const match = triggers.find((trigger) => triggerMatchesTag(trigger, expectedTag));
      if (match !== undefined && FAILED_TRIGGER_STATUSES.includes(match.status)) {
        throw new Error(
          `image build for expected tag ${expectedTag} reached terminal status ${match.status}; image-source: ${JSON.stringify(lastImageSource)}`,
        );
      }
      if (match !== undefined && IN_FLIGHT_TRIGGER_STATUSES.includes(match.status)) {
        // A matching build is legitimately in flight: slide the base window
        // forward from this observation, but never past the hard cap.
        deadline = Math.min(hardDeadline, clock.now() + IMAGE_ROLLOUT_BASE_DEADLINE_MS);
      }
      const catalog = await pollJson(baseUrl, jar, "/api/base-images");
      lastHttpStatus = catalog.status;
      if ("body" in catalog) {
        lastImages = enabledCatalogImages(catalog.body);
        onPoll?.({ enabledImages: lastImages, imageSource: lastImageSource });
        if (lastImages.some((image) => image.endsWith(`:${expectedTag}`))) {
          return chooseEnabledImage(lastImages, expectedTag);
        }
      }
    }
    await clock.sleep(IMAGE_ROLLOUT_POLL_INTERVAL_MS);
  }
  const details = [
    `enabled base image did not roll to expected tag ${expectedTag} within ${String(clock.now() - start)}ms`,
    `last HTTP status: ${lastHttpStatus === undefined ? "(none)" : String(lastHttpStatus)}`,
    `enabled images: ${lastImages.join(", ")}`,
    `image-source: ${JSON.stringify(lastImageSource)}`,
  ];
  throw new Error(details.join("; "));
}

/**
 * Extract the enabled image refs from the /api/base-images payload. A payload
 * without a `baseImages` array is a contract problem, not an empty catalog —
 * fail loudly instead of silently reporting zero images.
 */
function enabledCatalogImages(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || !("baseImages" in raw)) {
    throw new Error(
      `/api/base-images payload did not contain a baseImages array: ${JSON.stringify(raw)}`,
    );
  }
  const candidates: unknown = raw.baseImages;
  if (!Array.isArray(candidates)) {
    throw new Error(
      `/api/base-images payload did not contain a baseImages array: ${JSON.stringify(raw)}`,
    );
  }
  return candidates.flatMap((candidate: unknown): string[] => {
    if (typeof candidate !== "object" || candidate === null) return [];
    if (!("enabled" in candidate) || candidate.enabled !== true) return [];
    if (!("image" in candidate) || typeof candidate.image !== "string") return [];
    return [candidate.image];
  });
}

export async function createWorkspace(
  baseUrl: string,
  jar: readonly StoredCookie[],
  baseImage: string,
  editor: Editor,
): Promise<string> {
  const res = await fetchWithCookies(`${baseUrl}/api/workspaces`, jar, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseImage, editor }),
  });
  if (res.status !== 201) {
    throw new Error(`create ${editor} workspace failed: ${String(res.status)} ${await res.text()}`);
  }
  const body = (await res.json()) as { id?: string };
  if (typeof body.id !== "string") throw new Error(`create ${editor} returned no workspace id`);
  return body.id;
}

export async function waitReady(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
  clock: WaitClock = REAL_CLOCK,
): Promise<void> {
  const deadline = clock.now() + READY_DEADLINE_MS;
  let last = "";
  let lastHttpStatus: number | undefined;
  while (clock.now() < deadline) {
    const res = await pollJson(baseUrl, jar, `/api/workspaces/${id}`);
    lastHttpStatus = res.status;
    if ("body" in res) {
      const body = res.body as { state?: string; functional?: string };
      last = JSON.stringify(body);
      if (body.state === "running" && body.functional === "ok") return;
      if (body.state === "error") throw new Error(`workspace ${id} entered error: ${last}`);
    }
    await clock.sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `workspace ${id} did not become ready before deadline; last HTTP status: ${String(lastHttpStatus)}; last=${last}`,
  );
}

/**
 * Poll a workspace until it is gone (404) or, when `doneState` is given, until
 * it reports that lifecycle state. Shared by the terminated/purged waits.
 */
async function waitWorkspaceGone(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
  clock: WaitClock,
  spec: {
    readonly deadlineMs: number;
    readonly pollIntervalMs: number;
    readonly doneState?: string;
    readonly failure: string;
  },
): Promise<void> {
  const deadline = clock.now() + spec.deadlineMs;
  let last = "";
  let lastHttpStatus: number | undefined;
  while (clock.now() < deadline) {
    const res = await pollJson(baseUrl, jar, `/api/workspaces/${id}`);
    lastHttpStatus = res.status;
    if (res.status === NOT_FOUND_STATUS) return;
    if ("body" in res && spec.doneState !== undefined) {
      const body = res.body as { state?: string };
      last = JSON.stringify(body);
      if (body.state === spec.doneState) return;
    }
    await clock.sleep(spec.pollIntervalMs);
  }
  throw new Error(
    `workspace ${id} ${spec.failure}; last HTTP status: ${String(lastHttpStatus)}${
      last === "" ? "" : `; last=${last}`
    }`,
  );
}

export async function waitTerminated(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
  clock: WaitClock = REAL_CLOCK,
): Promise<void> {
  await waitWorkspaceGone(baseUrl, jar, id, clock, {
    deadlineMs: TERMINATED_DEADLINE_MS,
    pollIntervalMs: TERMINATED_POLL_INTERVAL_MS,
    doneState: "terminated",
    failure: "did not terminate after delete before deadline",
  });
}

async function waitPurged(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
  clock: WaitClock = REAL_CLOCK,
): Promise<void> {
  await waitWorkspaceGone(baseUrl, jar, id, clock, {
    deadlineMs: PURGED_DEADLINE_MS,
    pollIntervalMs: PURGED_POLL_INTERVAL_MS,
    failure: "still existed after purge deadline",
  });
}

async function primeEditorToken(
  baseUrl: string,
  jar: StoredCookie[],
  id: string,
  editor: Editor,
): Promise<void> {
  const root = `${baseUrl}/w/${id}/`;
  const docHeaders = { "sec-fetch-dest": "document", accept: "text/html" };
  const first = await fetchWithCookies(root, jar, { headers: docHeaders });
  if (first.status !== 302) {
    throw new Error(
      `${editor} initial open returned ${String(first.status)}, expected token redirect`,
    );
  }
  const tokenLocation = first.headers.get("location");
  if (tokenLocation?.includes("?tkn=") !== true) {
    throw new Error(`${editor} initial open did not redirect with ?tkn`);
  }
  const second = await fetchWithCookies(new URL(tokenLocation, baseUrl).toString(), jar, {
    headers: docHeaders,
  });
  absorb(jar, second);
  if (second.status !== 302) {
    throw new Error(
      `${editor} token open returned ${String(second.status)}, expected clean redirect`,
    );
  }
}

export async function openEditor(
  baseUrl: string,
  jar: StoredCookie[],
  id: string,
  editor: Editor,
): Promise<void> {
  const root = `${baseUrl}/w/${id}/`;
  if (editor === "opencode") {
    const res = await fetchWithCookies(root, jar, {
      headers: { "sec-fetch-dest": "document", accept: "text/html" },
    });
    if (res.status !== 200) {
      throw new Error(
        `${editor} clean open did not return 200: ${String(res.status)} ${await res.text()}`,
      );
    }
    const html = await res.text();
    if (!html.includes("opencode")) {
      throw new Error("opencode clean open did not return the opencode web client document");
    }
    return;
  }
  await primeEditorToken(baseUrl, jar, id, editor);
  if (!hasCookie(jar, root, cookieNameForEditor(editor))) {
    throw new Error(`${editor} token open did not set ${cookieNameForEditor(editor)}`);
  }
  const third = await fetchWithCookies(root, jar, {
    headers: { "sec-fetch-dest": "document", accept: "text/html" },
  });
  if (third.status !== 200) {
    throw new Error(
      `${editor} clean open did not return 200: ${String(third.status)} ${await third.text()}`,
    );
  }
}

async function deleteWorkspace(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
): Promise<void> {
  const res = await fetchWithCookies(`${baseUrl}/api/workspaces/${id}`, jar, { method: "DELETE" });
  if (res.status !== 202 && res.status !== 204 && res.status !== 404) {
    throw new Error(`delete ${id} failed: ${String(res.status)} ${await res.text()}`);
  }
}

async function purgeWorkspace(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
): Promise<void> {
  const res = await fetchWithCookies(`${baseUrl}/api/workspaces/${id}/purge`, jar, {
    method: "POST",
  });
  if (res.status !== 202 && res.status !== 404) {
    throw new Error(`purge ${id} failed: ${String(res.status)} ${await res.text()}`);
  }
}

/** Delete → wait terminated → purge → wait purged for one workspace. */
async function cleanupWorkspaceChain(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
): Promise<void> {
  await deleteWorkspace(baseUrl, jar, id);
  await waitTerminated(baseUrl, jar, id);
  await purgeWorkspace(baseUrl, jar, id);
  await waitPurged(baseUrl, jar, id);
}

/**
 * Best-effort teardown shared by the deployed smoke scripts: every created
 * workspace's delete→purge chain runs to completion independently
 * (`Promise.allSettled`, so one failure never abandons the rest), then the auth
 * session is always revoked. Returns the list of cleanup failures so the caller
 * can decide whether they should surface — a body failure must always take
 * precedence over a cleanup failure.
 */
export async function cleanupSmokeWorkspaces(
  baseUrl: string,
  jar: readonly StoredCookie[],
  created: readonly string[],
  revoke: () => Promise<void>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  const settled = await Promise.allSettled(
    created.map((id) => cleanupWorkspaceChain(baseUrl, jar, id)),
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      failures.push(
        new Error(`cleanup of workspace ${created[index]} failed`, { cause: outcome.reason }),
      );
    }
  }
  try {
    await revoke();
  } catch (e) {
    failures.push(new Error("revokeAuthSession failed", { cause: e }));
  }
  return failures;
}

/**
 * Owner-id prefixes the deployed smoke flows create workspaces under
 * (`authJar(secret, prefix)` appends `-<uuid>`): `smoke-shot-` for the
 * screenshot script and `smoke-` for check-deployed-workspace-open. The
 * post-deploy sweep deletes any leftover workspace whose owner matches.
 */
const SMOKE_OWNER_PREFIXES: readonly string[] = ["smoke-shot-", "smoke-"];

const LIST_DEADLINE_MS = 2 * 60 * 1000;
const LIST_POLL_INTERVAL_MS = 5_000;

interface WorkspaceRef {
  readonly id: string;
  readonly ownerId: string;
}

/**
 * Extract workspace refs from the /api/workspaces payload. A payload without
 * a `workspaces` array of `{ id, ownerId }` objects is a contract problem —
 * fail loudly (same policy as `enabledCatalogImages`).
 */
function workspaceRefs(raw: unknown): readonly WorkspaceRef[] {
  if (typeof raw !== "object" || raw === null || !("workspaces" in raw)) {
    throw new Error(
      `/api/workspaces payload did not contain a workspaces array: ${JSON.stringify(raw)}`,
    );
  }
  const candidates: unknown = raw.workspaces;
  if (!Array.isArray(candidates)) {
    throw new Error(
      `/api/workspaces payload did not contain a workspaces array: ${JSON.stringify(raw)}`,
    );
  }
  return candidates.map((candidate: unknown): WorkspaceRef => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("id" in candidate) ||
      typeof candidate.id !== "string" ||
      !("ownerId" in candidate) ||
      typeof candidate.ownerId !== "string"
    ) {
      throw new Error(
        `/api/workspaces entry was not a recognizable workspace: ${JSON.stringify(candidate)}`,
      );
    }
    return { id: candidate.id, ownerId: candidate.ownerId };
  });
}

/** List every workspace (admin session) owned by one of the smoke prefixes. */
async function listSmokeWorkspaces(
  baseUrl: string,
  jar: readonly StoredCookie[],
  ownerPrefixes: readonly string[] = SMOKE_OWNER_PREFIXES,
  clock: WaitClock = REAL_CLOCK,
): Promise<readonly WorkspaceRef[]> {
  const deadline = clock.now() + LIST_DEADLINE_MS;
  let lastHttpStatus: number | undefined;
  while (clock.now() < deadline) {
    const res = await pollJson(baseUrl, jar, "/api/workspaces");
    lastHttpStatus = res.status;
    if ("body" in res) {
      return workspaceRefs(res.body).filter((ws) =>
        ownerPrefixes.some((prefix) => ws.ownerId.startsWith(prefix)),
      );
    }
    await clock.sleep(LIST_POLL_INTERVAL_MS);
  }
  throw new Error(
    `listing workspaces for the smoke sweep did not succeed before deadline; last HTTP status: ${String(lastHttpStatus)}`,
  );
}

export interface SweepResult {
  readonly swept: readonly string[];
  readonly failures: readonly Error[];
}

/**
 * Best-effort deletion of every leftover smoke-owned workspace: each chain
 * (delete → terminated → purge → purged) runs to completion independently so
 * one stuck workspace never aborts the others. The caller decides whether
 * failures fail the run.
 */
export async function sweepSmokeWorkspaces(
  baseUrl: string,
  jar: readonly StoredCookie[],
  ownerPrefixes: readonly string[] = SMOKE_OWNER_PREFIXES,
  clock: WaitClock = REAL_CLOCK,
): Promise<SweepResult> {
  const leftovers = await listSmokeWorkspaces(baseUrl, jar, ownerPrefixes, clock);
  const settled = await Promise.allSettled(
    leftovers.map(async (ws) => {
      await deleteWorkspace(baseUrl, jar, ws.id);
      await waitTerminated(baseUrl, jar, ws.id, clock);
      await purgeWorkspace(baseUrl, jar, ws.id);
      await waitPurged(baseUrl, jar, ws.id, clock);
    }),
  );
  const swept: string[] = [];
  const failures: Error[] = [];
  for (const [index, outcome] of settled.entries()) {
    const ws = leftovers[index];
    if (outcome.status === "fulfilled") {
      swept.push(ws.id);
    } else {
      failures.push(
        new Error(`sweep of leftover smoke workspace ${ws.id} (owner ${ws.ownerId}) failed`, {
          cause: outcome.reason,
        }),
      );
    }
  }
  return { swept, failures };
}
