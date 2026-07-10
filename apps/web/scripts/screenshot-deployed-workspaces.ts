// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, type Page } from "@playwright/test";

import { revokeAuthSession } from "../lib/auth-sessions";

import {
  EDITORS,
  type Editor,
  type StoredCookie,
  authJar,
  authSecret,
  createWorkspace,
  deleteWorkspace,
  purgeWorkspace,
  requiredEnv,
  waitPurged,
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

const MAX_BROWSER_EVENT_LINES = 80;

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

async function assertWorkspaceHomeLink(editor: Editor, page: Page): Promise<void> {
  const link = page.locator("#edd-workspaces-home, #edd-home").first();
  await expect(link, `${editor} did not expose a visible EDD workspaces link`).toBeVisible({
    timeout: 15_000,
  });
  const href = await link.getAttribute("href");
  if (href !== "/workspaces" && href?.endsWith("/workspaces") !== true) {
    throw new Error(`${editor} EDD workspaces link pointed to ${href ?? "(missing href)"}`);
  }
  await link.click();
  await page.waitForURL(/\/workspaces(?:\?|$)/, { timeout: 15_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  if (editor === "openvscode") {
    await expect(page.locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
  } else if (editor === "terminal") {
    await page.locator("#terminal-panes .xterm").first().waitFor({ state: "visible" });
  } else if (editor === "monaco") {
    await page.locator("#editor").waitFor({ state: "visible" });
  } else {
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("opencode"));
  }
}

async function assertOpenVscodeFileMenu(page: Page): Promise<void> {
  const fileMenu = page
    .locator(
      '[role="menuitem"][aria-label="File"], .menubar-menu-button[aria-label="File"], .menubar-menu-button:has-text("File")',
    )
    .first();
  await expect(fileMenu, "OpenVSCode did not show a visible File menu").toBeVisible({
    timeout: 30_000,
  });
  await fileMenu.click();
  await expect(
    page.locator(".monaco-menu-container, .context-view.monaco-menu, [role='menu']").first(),
    "OpenVSCode File menu did not open after a real click",
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("menuitem", { name: /New (Text )?File|Open File|Open Folder/ }).first(),
    "OpenVSCode File menu did not expose real file actions",
  ).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
}

async function writeTerminalFile(page: Page, file: string, value: string): Promise<void> {
  await page.locator(".xterm-screen").first().click();
  await page.keyboard.type(`printf '${value}\\n' > ${file}`, { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    async ([path, expected]) => {
      const res = await fetch(`api/file?path=${encodeURIComponent(path)}`);
      return res.ok && (await res.text()).trim() === expected;
    },
    [file, value],
    { timeout: 30_000 },
  );
}

async function assertTerminalWorkflow(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.innerText.includes("Terminal"));
  await page.locator("#terminal-panes .xterm").first().waitFor({ state: "visible" });
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await writeTerminalFile(page, "edd-smoke-terminal-1.txt", "terminal-one");

  await page.locator("#new-terminal-tab").click();
  await expect(page.locator(".terminal-tab")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("tab", { name: "Terminal 1" }).click();
  await page.getByRole("tab", { name: "Terminal 2" }).click();
  await writeTerminalFile(page, "edd-smoke-terminal-2.txt", "terminal-two");

  await page.locator(".terminal-tab.active .terminal-tab-close").click();
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("tab", { name: "Terminal 2" })).toHaveCount(0);
}

async function writeDiagnostic(
  editor: Editor,
  id: string,
  page: Page,
  detail: string,
  browserEvents: readonly string[],
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
      "browser-events:",
      ...(browserEvents.length > 0 ? browserEvents : ["(none captured)"]),
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
  switch (editor) {
    case "monaco": {
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
      break;
    }
    case "terminal":
      await assertTerminalWorkflow(page);
      break;
    case "opencode":
      await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("opencode"));
      break;
    case "openvscode":
      await expect(page.locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
      await assertOpenVscodeFileMenu(page);
      break;
  }
  await assertWorkspaceHomeLink(editor, page);
}

process.env.DYNAMODB_TABLE = table;
process.env.AWS_REGION = region;

await mkdir(OUT_DIR, { recursive: true });
const secret = await authSecret(region, secretId);
const { jar, sessionId } = await authJar(secret, "smoke-shot");
const created: string[] = [];
const browser = await chromium.launch();
try {
  const catalogPolls: unknown[] = [];
  let baseImage: string;
  try {
    baseImage = await waitEnabledImage(baseUrl, jar, expectedSha, (snapshot) => {
      catalogPolls.push({
        at: new Date().toISOString(),
        ...snapshot,
      });
      if (catalogPolls.length > 100) catalogPolls.shift();
    });
  } catch (e) {
    await writeFile(
      join(OUT_DIR, "catalog-rollout-failure.json"),
      `${JSON.stringify(
        {
          expectedSha,
          error: e instanceof Error ? (e.stack ?? e.message) : String(e),
          polls: catalogPolls,
        },
        null,
        2,
      )}\n`,
    );
    throw e;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addCookies(jar.map((cookie) => playwrightCookie(baseHost, cookie)));
  const page = await context.newPage();
  const browserEvents: string[] = [];
  const recordBrowserEvent = (line: string): void => {
    browserEvents.push(line);
    if (browserEvents.length > MAX_BROWSER_EVENT_LINES) browserEvents.shift();
  };
  page.on("console", (msg) => {
    recordBrowserEvent(`console:${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => {
    recordBrowserEvent(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    recordBrowserEvent(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });

  for (const editor of EDITORS) {
    browserEvents.length = 0;
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
        browserEvents,
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
      await purgeWorkspace(baseUrl, jar, id);
      await waitPurged(baseUrl, jar, id);
    }),
  );
  await revokeAuthSession(sessionId);
}
