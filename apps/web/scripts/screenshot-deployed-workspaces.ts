// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { revokeAuthSession } from "../lib/auth-sessions";

import {
  EDITORS,
  type StoredCookie,
  authJar,
  authSecret,
  createWorkspace,
  deleteWorkspace,
  firstEnabledImage,
  primeEditorToken,
  requiredEnv,
  waitReady,
} from "./deployed-workspace-smoke-lib";

const OUT_DIR = process.env.EDD_SHOT_OUT ?? join(tmpdir(), "edd-workspace-screenshots");

function playwrightCookie(baseHost: string, cookie: StoredCookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: baseHost,
    path: cookie.path,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  };
}

const baseUrl = requiredEnv("EDD_APP_URL").replace(/\/$/, "");
const baseHost = new URL(baseUrl).hostname;
const region = requiredEnv("AWS_REGION");
const table = requiredEnv("DYNAMODB_TABLE");
const secretId = requiredEnv("AUTH_SECRET_ID");

process.env.DYNAMODB_TABLE = table;
process.env.AWS_REGION = region;

await mkdir(OUT_DIR, { recursive: true });
const secret = await authSecret(region, secretId);
const { jar, sessionId } = await authJar(secret, "smoke-shot");
const created: string[] = [];
const browser = await chromium.launch();
try {
  const baseImage = await firstEnabledImage(baseUrl, jar);
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addCookies(jar.map((cookie) => playwrightCookie(baseHost, cookie)));
  const page = await context.newPage();

  for (const editor of EDITORS) {
    const id = await createWorkspace(baseUrl, jar, baseImage, editor);
    created.push(id);
    await waitReady(baseUrl, jar, id);
    await primeEditorToken(baseUrl, jar, id, editor);
    await context.addCookies(jar.map((cookie) => playwrightCookie(baseHost, cookie)));
    const response = await page.goto(`${baseUrl}/w/${id}/`, { waitUntil: "domcontentloaded" });
    if (response !== null && response.status() >= 400) {
      throw new Error(`${editor} browser open returned ${String(response.status())}`);
    }
    await page.waitForTimeout(5_000);
    const bodyText = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).toLowerCase();
    for (const forbidden of ["unauthorized", "forbidden", "http error 502", "server error"]) {
      if (bodyText.includes(forbidden)) throw new Error(`${editor} rendered ${forbidden}`);
    }
    const path = join(OUT_DIR, `${editor}-${id}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`edd: captured ${editor} screenshot ${path}`);
  }
} finally {
  await browser.close();
  await Promise.allSettled(created.map((id) => deleteWorkspace(baseUrl, jar, id)));
  await revokeAuthSession(sessionId);
}
