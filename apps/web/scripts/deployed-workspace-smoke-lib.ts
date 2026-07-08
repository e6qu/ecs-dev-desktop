// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { encode } from "next-auth/jwt";

import { AUTH_SESSION_SCHEMA_VERSION, createAuthSession } from "../lib/auth-sessions";

export type Editor = "openvscode" | "monaco" | "claude" | "codex";

export const EDITORS: readonly Editor[] = ["openvscode", "monaco", "claude", "codex"];
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
    case "claude":
    case "codex":
      return "vscode-tkn";
    case "monaco":
      return "edd-editor-token";
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

export async function waitEnabledImage(
  baseUrl: string,
  jar: readonly StoredCookie[],
  expectedTag: string,
): Promise<string> {
  const deadline = Date.now() + 20 * 60 * 1000;
  let lastImages: readonly string[] = [];
  while (Date.now() < deadline) {
    lastImages = await enabledCatalogImages(baseUrl, jar);
    if (lastImages.some((image) => image.endsWith(`:${expectedTag}`))) {
      return chooseEnabledImage(lastImages, expectedTag);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    `enabled base image did not roll to expected tag ${expectedTag} before deadline; enabled images: ${lastImages.join(", ")}`,
  );
}

async function enabledCatalogImages(
  baseUrl: string,
  jar: readonly StoredCookie[],
): Promise<string[]> {
  const res = await fetchWithCookies(`${baseUrl}/api/base-images`, jar);
  if (!res.ok) throw new Error(`/api/base-images failed: ${String(res.status)}`);
  const raw: unknown = await res.json();
  if (typeof raw !== "object" || raw === null || !("baseImages" in raw)) return [];
  const candidates = raw.baseImages;
  if (!Array.isArray(candidates)) return [];
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
): Promise<void> {
  const deadline = Date.now() + 8 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetchWithCookies(`${baseUrl}/api/workspaces/${id}`, jar);
    if (!res.ok) throw new Error(`inspect ${id} failed: ${String(res.status)}`);
    const body = (await res.json()) as { state?: string; functional?: string };
    last = JSON.stringify(body);
    if (body.state === "running" && body.functional === "ok") return;
    if (body.state === "error") throw new Error(`workspace ${id} entered error: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`workspace ${id} did not become ready before deadline; last=${last}`);
}

export async function waitTerminated(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
): Promise<void> {
  const deadline = Date.now() + 20 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetchWithCookies(`${baseUrl}/api/workspaces/${id}`, jar);
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`inspect deleted ${id} failed: ${String(res.status)}`);
    const body = (await res.json()) as { state?: string };
    last = JSON.stringify(body);
    if (body.state === "terminated") return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`workspace ${id} did not terminate after delete before deadline; last=${last}`);
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
  await primeEditorToken(baseUrl, jar, id, editor);
  if (!hasCookie(jar, root, cookieNameForEditor(editor))) {
    throw new Error(`${editor} token open did not set ${cookieNameForEditor(editor)}`);
  }
  const third = await fetchWithCookies(root, jar, {
    headers: { "sec-fetch-dest": "document", accept: "text/html" },
  });
  if (third.status >= 400) {
    throw new Error(`${editor} clean open failed: ${String(third.status)} ${await third.text()}`);
  }
}

export async function deleteWorkspace(
  baseUrl: string,
  jar: readonly StoredCookie[],
  id: string,
): Promise<void> {
  const res = await fetchWithCookies(`${baseUrl}/api/workspaces/${id}`, jar, { method: "DELETE" });
  if (res.status !== 202 && res.status !== 204 && res.status !== 404) {
    throw new Error(`delete ${id} failed: ${String(res.status)} ${await res.text()}`);
  }
}
