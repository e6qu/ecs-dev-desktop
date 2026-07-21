// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { chromium, type Browser, type Page } from "@playwright/test";
import { workspace, type WorkspaceDto } from "@edd/api-contracts";
import { deriveWorkspaceToken } from "@edd/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { devHeaders } from "./web-app";
import { startIdeBridge, type IdeBridge } from "./ide-bridge";
import {
  createRunningWorkspace,
  initLiveEnv,
  newSecret,
  startEditorApp,
  WORKSPACE_IMAGE,
  type LiveEcsApp,
} from "./live-editor-fixture";

initLiveEnv();

const OWNER = "terminal-browser-user";
const RUN_ID = `terminal-${randomUUID().slice(0, 8)}`;
const CONNECTION_SECRET = newSecret();

async function currentWorkspace(app: LiveEcsApp, id: string): Promise<WorkspaceDto> {
  const response = await fetch(`${app.web.baseUrl}/api/workspaces/${id}`, {
    headers: devHeaders(OWNER, "developer"),
  });
  if (!response.ok) {
    throw new Error(
      `workspace read returned HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  return workspace.parse(await response.json());
}

async function waitForState(
  app: LiveEcsApp,
  id: string,
  expected: WorkspaceDto["state"],
): Promise<WorkspaceDto> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = await currentWorkspace(app, id);
    if (current.state === expected) return current;
    if (Date.now() > deadline) {
      throw new Error(`workspace ${id} never reached ${expected} (last: ${current.state})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function interactiveShells(container: string): number {
  const script = [
    "const fs=require('node:fs')",
    "for(const name of fs.readdirSync('/proc').filter((entry)=>/^\\d+$/.test(entry))){",
    "try{console.log(fs.readFileSync(`/proc/${name}/cmdline`).toString().replaceAll('\\0',' '))}",
    "catch(error){if(error?.code!=='ENOENT'&&error?.code!=='EACCES')throw error}",
    "}",
  ].join("\n");
  const processes = execFileSync("docker", ["exec", container, "node", "-e", script], {
    encoding: "utf8",
  });
  return processes.split("\n").filter((line) => /\/bin\/bash -l -i(?: |$)/.test(line)).length;
}

async function openTerminal(
  browser: Browser,
  workspaceId: string,
): Promise<{ bridge: IdeBridge; page: Page }> {
  const bridge = await startIdeBridge({
    workspaceId,
    image: WORKSPACE_IMAGE,
    extractConnectionToken: false,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const token = deriveWorkspaceToken(CONNECTION_SECRET, workspaceId);
  await page.goto(`http://127.0.0.1:${String(bridge.port)}/w/${workspaceId}/?tkn=${token}`);
  await page.locator("#terminal-panes .xterm").first().waitFor({ state: "visible" });
  expect(errors, errors.join("\n")).toEqual([]);
  return { bridge, page };
}

async function writeThroughTerminal(page: Page, file: string, value: string): Promise<void> {
  await page.locator(".terminal-pane:not([hidden]) .xterm-screen").click();
  await page.keyboard.type(`printf '${value}\\n' > ${file}`, { delay: 10 });
  await page.keyboard.press("Enter");
  await vi.waitFor(
    async () => {
      const actual = await page.evaluate(async (path) => {
        const response = await fetch(`api/file?path=${encodeURIComponent(path)}`);
        return response.ok ? (await response.text()).trim() : "";
      }, file);
      expect(actual).toBe(value);
    },
    { timeout: 30_000, interval: 500 },
  );
}

describe(
  "LIVE terminal browser and workspace lifecycle on container-mode simulator",
  { timeout: 600_000 },
  () => {
    let app: LiveEcsApp;
    let browser: Browser | undefined;
    let bridge: IdeBridge | undefined;
    let page: Page | undefined;
    let workspaceId = "";

    beforeAll(async () => {
      app = await startEditorApp({
        runId: RUN_ID,
        vpcCidr: "10.84.0.0/16",
        subnetCidr: "10.84.1.0/24",
        connectionSecret: CONNECTION_SECRET,
        editor: "terminal",
      });
      browser = await chromium.launch({ headless: true });
    });

    afterAll(async () => {
      await page?.close();
      bridge?.close();
      await browser?.close();
      await app.stop();
    });

    it("types through real terminal WebSockets, closes PTYs, survives stop and wake, and deletes", async () => {
      if (!browser) {
        throw new Error("Chromium did not start for the terminal browser lifecycle");
      }
      const created = await createRunningWorkspace(app, OWNER);
      workspaceId = created.id;
      ({ bridge, page } = await openTerminal(browser, workspaceId));

      await expect.poll(() => interactiveShells(bridge?.container ?? "")).toBe(1);
      await writeThroughTerminal(page, "terminal-before-stop.txt", "before-stop");

      await page.locator("#new-terminal-tab").click();
      await page.locator(".terminal-tab").nth(1).waitFor();
      await expect.poll(() => interactiveShells(bridge?.container ?? "")).toBe(2);
      await writeThroughTerminal(page, "terminal-second-tab.txt", "second-tab");
      await page.locator(".terminal-tab.active .terminal-tab-close").click();
      await expect.poll(() => interactiveShells(bridge?.container ?? "")).toBe(1);

      bridge.close();
      bridge = undefined;
      await page.close();
      page = undefined;

      const stop = await fetch(`${app.web.baseUrl}/api/workspaces/${workspaceId}/stop`, {
        method: "POST",
        headers: devHeaders(OWNER, "developer"),
      });
      expect(stop.status, await stop.text()).toBe(200);
      await waitForState(app, workspaceId, "stopped");

      const wake = await fetch(`${app.web.baseUrl}/api/workspaces/${workspaceId}/connect`, {
        method: "POST",
        headers: devHeaders(OWNER, "developer"),
      });
      expect(wake.status, await wake.text()).toBe(200);
      await waitForState(app, workspaceId, "running");

      ({ bridge, page } = await openTerminal(browser, workspaceId));
      const persisted = await page.evaluate(async () => {
        const response = await fetch("api/file?path=terminal-before-stop.txt");
        return response.ok ? (await response.text()).trim() : "";
      });
      expect(persisted).toBe("before-stop");
      await writeThroughTerminal(page, "terminal-after-wake.txt", "after-wake");

      const remove = await fetch(`${app.web.baseUrl}/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: devHeaders(OWNER, "developer"),
      });
      expect(remove.status, await remove.text()).toBe(202);
      expect((await currentWorkspace(app, workspaceId)).state).toBe("deleting");
    });
  },
);
