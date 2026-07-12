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
  cleanupSmokeWorkspaces,
  createWorkspace,
  requiredEnv,
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

/** Editor/tool state that must NOT appear in the user's project dir (it lives in HOME/=/data/home,
 * out of the pwd). A fresh workspace's project tree must contain none of these. */
const EDITOR_STATE_LEAKS = [
  ".openvscode-server",
  ".vscode-server",
  ".config",
  ".local",
  ".cache",
  ".npm-global",
  ".npm",
  ".bash_history",
  "go/pkg",
];

/**
 * Assert the workspace project dir (the editor's opened folder / pwd) is CLEAN — no editor/software
 * state leaked into it. Must run on a FRESH workspace BEFORE the smoke writes its own files. Reads
 * the editor's confined file tree (rooted at the project dir); any entry whose top path component
 * is an editor-state dotfile is a leak (task: keep the pwd clean; editor state lives in HOME).
 */
async function assertProjectDirClean(editor: Editor, page: Page): Promise<void> {
  const entries = await page.evaluate(async () => {
    const res = await fetch("api/tree");
    if (!res.ok) throw new Error(`tree read failed: ${String(res.status)}`);
    const raw = (await res.json()) as { entries?: { path: string }[] };
    return (raw.entries ?? []).map((e) => e.path);
  });
  const tops = new Set(entries.map((p) => p.split("/")[0]));
  const leaked = EDITOR_STATE_LEAKS.filter((leak) => tops.has(leak));
  if (leaked.length > 0) {
    throw new Error(
      `${editor}: editor/software state leaked into the project pwd: ${leaked.join(", ")} (should live in HOME=/data/home, not the project). Tree: ${entries.slice(0, 40).join(", ")}`,
    );
  }
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
    await assertOpencodeMounted(page);
  }
}

/**
 * opencode is a SolidJS SPA mounted into `<div id="root">`. Assert the ROUTED MAIN UI actually
 * renders — not merely that the app mounted. The mounted-but-blank failure mode (before the
 * base-path routing fix) left `#root` containing ONLY `<div data-component="dialog-stack">` (the
 * out-of-`<Routes>` overlay container) because opencode's path-router matched no route under the
 * `/w/<id>/` proxy prefix. The proxy now patches the router's path read (see
 * `patchOpencodeRouterBase` / the shim's `__eddStrip`) so it matches as if at `/`, which mounts
 * the header + main layout. Requiring a real chrome element (header / an interactive control)
 * catches a regression to the blank state — which the old `childElementCount > 0` check missed.
 */
async function assertOpencodeMounted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      if (root === null) return false;
      // The blank state is ONLY the dialog-stack container; the real UI adds a header + controls.
      return root.querySelector("header, [data-component='icon-button'], button") !== null;
    },
    undefined,
    { timeout: 60_000 },
  );
  const title = await page.title();
  if (!title.toLowerCase().includes("opencode")) {
    throw new Error(`opencode mounted but document.title was unexpectedly "${title}"`);
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
  // Focus the ACTIVE terminal, not `.xterm-screen` .first(): once a second tab is
  // open, the inactive pane is `[hidden]` (display:none), so `.first()` resolves to
  // an invisible screen and the click never becomes actionable. Each inactive pane
  // carries the `hidden` attribute (see the SPA's activateTab), so scope to the one
  // without it.
  await page.locator(".terminal-pane:not([hidden]) .xterm-screen").first().click();
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

/** The visible tab labels, in DOM (tab-strip) order. */
async function terminalTabNames(page: Page): Promise<string[]> {
  return page.locator(".terminal-tab-select").allInnerTexts();
}

async function assertTerminalWorkflow(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.innerText.includes("Terminal"));
  await page.locator("#terminal-panes .xterm").first().waitFor({ state: "visible" });
  // Fresh workspace: the project dir (pwd) must be clean — no editor/software state leaked in.
  await assertProjectDirClean("terminal", page);
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await writeTerminalFile(page, "edd-smoke-terminal-1.txt", "terminal-one");

  await page.locator("#new-terminal-tab").click();
  await expect(page.locator(".terminal-tab")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("tab", { name: "Terminal 1" }).click();
  await page.getByRole("tab", { name: "Terminal 2" }).click();
  await writeTerminalFile(page, "edd-smoke-terminal-2.txt", "terminal-two");

  // Rename a tab (double-click → inline input → Enter); an empty name reverts to the default.
  await page.getByRole("tab", { name: "Terminal 2" }).dblclick();
  await page.locator(".terminal-tab-rename").fill("build");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "build" })).toHaveCount(1, { timeout: 10_000 });
  await page.getByRole("tab", { name: "build" }).dblclick();
  await page.locator(".terminal-tab-rename").fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Terminal 2" })).toHaveCount(1, { timeout: 10_000 });

  // Reorder via the accessible keyboard move (Alt+Shift+←): Terminal 2 moves ahead of Terminal 1.
  await page.getByRole("tab", { name: "Terminal 2" }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect
    .poll(() => terminalTabNames(page), { timeout: 10_000 })
    .toEqual(["Terminal 2", "Terminal 1"]);

  // Close the active tab: back to one, and the closed tab's label is gone.
  await page.locator(".terminal-tab.active .terminal-tab-close").click();
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
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

async function assertRenderedWorkspace(editor: Editor, page: Page): Promise<void> {
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
      // Fresh workspace: the project dir must be clean (editor state lives in HOME, not the pwd).
      await assertProjectDirClean(editor, page);
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
      await assertOpencodeMounted(page);
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

/**
 * Failure record for the artifact upload: failures before the browser section
 * (createWorkspace/waitReady) would otherwise leave OUT_DIR empty and the
 * upload with nothing to attach.
 */
async function writeFailureRecord(error: unknown): Promise<void> {
  try {
    await writeFile(
      join(OUT_DIR, "smoke-failure.json"),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          expectedSha,
          createdWorkspaces: created,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        },
        null,
        2,
      )}\n`,
    );
  } catch (writeError) {
    console.error("edd: failed to write smoke failure record:", writeError);
  }
}

const browser = await chromium.launch();
let bodyFailed = false;
let bodyError: unknown;
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
      await assertRenderedWorkspace(editor, page);
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
} catch (e) {
  bodyFailed = true;
  bodyError = e;
  await writeFailureRecord(e);
}

try {
  await browser.close();
} catch (e) {
  console.error("edd: browser close failed:", e);
}
const cleanupFailures = await cleanupSmokeWorkspaces(baseUrl, jar, created, () =>
  revokeAuthSession(sessionId),
);
for (const failure of cleanupFailures) {
  console.error("edd: cleanup failure:", failure);
}
// A body failure is the primary signal — cleanup failures must never mask it.
if (bodyFailed) throw bodyError;
if (cleanupFailures.length > 0) {
  throw new Error(`workspace cleanup failed for ${String(cleanupFailures.length)} step(s)`);
}
