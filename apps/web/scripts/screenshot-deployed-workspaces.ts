// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";

import { revokeAuthSession } from "../lib/auth-sessions";

import {
  EDITORS,
  type Editor,
  type StoredCookie,
  authJar,
  authSecret,
  createWorkspace,
  deleteWorkspace,
  requiredEnv,
  waitTerminated,
  waitEnabledImage,
  waitReady,
} from "./deployed-workspace-smoke-lib";

const OUT_DIR = process.env.EDD_SHOT_OUT ?? join(tmpdir(), "edd-workspace-screenshots");
const BAD_RENDER_TEXT = [
  "unauthorized",
  "forbidden",
  "http error 502",
  "server error",
  "vendor harness log",
  "open the vendor",
  "remote control is running",
  "app-server is running",
  "cannot edit in read-only editor",
];

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
const expectedSha = requiredEnv("EXPECTED_SHA");

function bodySnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

async function treeContainsSmokeFile(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const res = await fetch("api/tree");
    if (!res.ok) throw new Error(`monaco tree read failed: ${String(res.status)}`);
    const raw: unknown = await res.json();
    return JSON.stringify(raw).includes("edd-smoke-monaco.txt");
  });
}

async function writeDiagnostic(
  editor: Editor,
  id: string,
  page: Page,
  detail: string,
): Promise<void> {
  const prefix = join(OUT_DIR, `${editor}-${id}-failure`);
  let screenshotDetail = "screenshot=written";
  try {
    await page.screenshot({ path: `${prefix}.png`, fullPage: true });
  } catch (e) {
    screenshotDetail = `screenshot=failed: ${String(e)}`;
  }
  const html = await page.content().catch((e: unknown) => `page.content failed: ${String(e)}`);
  const text = await page
    .locator("body")
    .innerText()
    .catch((e: unknown) => `body innerText failed: ${String(e)}`);
  await writeFile(
    `${prefix}.txt`,
    [
      `editor=${editor}`,
      `workspace=${id}`,
      `url=${page.url()}`,
      `detail=${detail}`,
      screenshotDetail,
      `body=${bodySnippet(text)}`,
      "",
      html,
    ].join("\n"),
    "utf8",
  );
}

async function assertRenderedWorkspace(editor: Editor, id: string, page: Page): Promise<void> {
  await page.waitForTimeout(5_000);
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).toLowerCase();
  for (const forbidden of BAD_RENDER_TEXT) {
    if (bodyText.includes(forbidden)) throw new Error(`${editor} rendered ${forbidden}`);
  }
  if (editor === "monaco") {
    await page.evaluate(async () => {
      const res = await fetch("api/file?path=edd-smoke-monaco.txt", {
        method: "PUT",
        body: "smoke\n",
      });
      if (!res.ok) throw new Error(`monaco file write failed: ${String(res.status)}`);
    });
    await page.waitForFunction(
      () => document.body.innerText.includes("edd-smoke-monaco.txt"),
      undefined,
      { timeout: 45_000 },
    );
    if (!(await treeContainsSmokeFile(page))) {
      throw new Error("monaco file API tree did not contain edd-smoke-monaco.txt after write");
    }
    await page.locator("button.file-row", { hasText: "edd-smoke-monaco.txt" }).click();
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("edited");
    await page.waitForTimeout(500);
    const afterType = await page.locator("body").innerText();
    if (afterType.includes("Cannot edit in read-only editor")) {
      throw new Error("monaco rendered Cannot edit in read-only editor after opening a file");
    }
  } else if (editor === "claude") {
    await page.waitForFunction(() => document.body.innerText.includes("Claude Code"));
  } else if (editor === "codex") {
    await page.waitForFunction(() => document.body.innerText.includes("Codex"));
  } else if (editor === "opencode") {
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("opencode"));
  }
}

process.env.DYNAMODB_TABLE = table;
process.env.AWS_REGION = region;

await mkdir(OUT_DIR, { recursive: true });
const secret = await authSecret(region, secretId);
const { jar, sessionId } = await authJar(secret, "smoke-shot");
const created: string[] = [];
const browser = await chromium.launch();
try {
  const baseImage = await waitEnabledImage(baseUrl, jar, expectedSha);
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addCookies(jar.map((cookie) => playwrightCookie(baseHost, cookie)));
  const page = await context.newPage();

  for (const editor of EDITORS) {
    const id = await createWorkspace(baseUrl, jar, baseImage, editor);
    created.push(id);
    await waitReady(baseUrl, jar, id);
    const response = await page.goto(`${baseUrl}/w/${id}/`, { waitUntil: "domcontentloaded" });
    if (response !== null && response.status() >= 400) {
      throw new Error(`${editor} browser open returned ${String(response.status())}`);
    }
    const path = join(OUT_DIR, `${editor}-${id}.png`);
    try {
      await assertRenderedWorkspace(editor, id, page);
      await page.screenshot({ path, fullPage: true });
      console.log(`edd: captured ${editor} screenshot ${path}`);
    } catch (e) {
      await writeDiagnostic(
        editor,
        id,
        page,
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
      throw e;
    }
  }
} finally {
  await browser.close();
  await Promise.all(
    created.map(async (id) => {
      await deleteWorkspace(baseUrl, jar, id);
      await waitTerminated(baseUrl, jar, id);
    }),
  );
  await revokeAuthSession(sessionId);
}
