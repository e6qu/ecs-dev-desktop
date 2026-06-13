// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof that the golden workspace image runs a REAL VS Code (OpenVSCode Server)
// a user can drive in a browser: load the workbench, open the integrated
// terminal, type code, compile it with the preinstalled toolchain, and verify
// the produced build artifact. Screenshots are captured as visual evidence.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { inWorkspace, VSCODE_URL } from "./vscode-support";

const SHOTS = join(import.meta.dirname, "vscode-shots");
const shot = (name: string): string => join(SHOTS, name);

const BUILD_MARKER = "EDD-VSCODE-BUILD-OK";
// A Go program written + compiled + run entirely from the VS Code terminal. The
// PATH export makes `go` resolvable regardless of whether the integrated
// terminal started a login shell.
const BUILD_COMMAND = [
  'export PATH="$PATH:/usr/local/go/bin"',
  "mkdir -p ~/proof && cd ~/proof",
  `printf 'package main\\nimport "fmt"\\nfunc main(){fmt.Println("${BUILD_MARKER}")}\\n' > hello.go`,
  "go build -o hello hello.go",
  "./hello",
].join(" && ");

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test("OpenVSCode workspace: load the workbench, compile from the terminal, verify the artifact", async ({
  page,
}) => {
  // 1. Load the real VS Code workbench in the browser.
  await page.goto(VSCODE_URL);
  await expect(page.locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
  // The editor area / activity bar render once the workbench is live.
  await expect(page.locator(".monaco-workbench .activitybar")).toBeVisible();
  // Safety net: if a Workspace Trust modal appears (the image disables it, but be
  // robust), accept it — a modal blocks all keyboard input.
  const trustButton = page.getByRole("button", { name: "Yes, I trust the authors" });
  if (await trustButton.isVisible().catch(() => false)) {
    await trustButton.click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: shot("01-workbench.png") });

  // 2. Open the integrated terminal. The welcome page is a webview iframe and the
  //    bundled chat panel grabs focus, so we must focus a NATIVE workbench part
  //    (the activity bar) before any keybinding will reach the workbench. Then
  //    toggle the terminal (Ctrl+`), falling back to the command palette.
  const terminal = page.locator(".xterm").first();
  // Raw coordinate click on the activity bar's empty area (x≈12) — a NATIVE
  // workbench part, not the welcome webview — to move keyboard focus to the
  // workbench. Coordinates avoid Playwright's actionability wait (locator clicks
  // on these parts hang).
  const focusWorkbench = async (): Promise<void> => {
    await page.mouse.click(12, 350);
    await page.waitForTimeout(300);
  };
  await focusWorkbench();
  await page.keyboard.press("Control+`");
  try {
    await expect(terminal).toBeVisible({ timeout: 8_000 });
  } catch {
    await focusWorkbench();
    await page.keyboard.press("ControlOrMeta+Shift+P");
    try {
      await expect(page.locator(".quick-input-widget")).toBeVisible({ timeout: 8_000 });
    } catch {
      await page.screenshot({ path: shot("debug-no-palette.png") });
      throw new Error("could not open the command palette");
    }
    await page.keyboard.type("Terminal: Create New Terminal");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await expect(terminal).toBeVisible({ timeout: 30_000 });
  }

  // 3. Type code + compile + run, all through the VS Code terminal. Wait for the
  //    shell to be ready and prime a clean prompt first — typing too early drops
  //    the leading keystrokes (xterm isn't attached to the pty yet).
  await page.locator(".xterm-screen").first().click();
  await page.waitForTimeout(2_500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await page.keyboard.type(BUILD_COMMAND, { delay: 25 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(10_000); // let the build run
  await page.screenshot({ path: shot("02-terminal-build.png") });

  // 4. Verify the build artifact exists, is a real ELF binary, and runs with the
  //    expected output — confirmed on the container filesystem (robust vs xterm
  //    scraping). The compile was driven by the keystrokes above.
  await expect
    .poll(
      () => {
        try {
          return inWorkspace("cd ~/proof && ./hello 2>/dev/null").trim();
        } catch {
          return "";
        }
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toContain(BUILD_MARKER);

  // ELF magic (0x7f 'E' 'L' 'F') proves it's a compiled binary, not a script.
  const magic = inWorkspace("od -An -tx1 -N4 ~/proof/hello").trim().replace(/\s+/g, " ");
  expect(magic).toBe("7f 45 4c 46");

  // 5. Best-effort: open the compiled source in the editor for a screenshot. The
  //    test's pass criteria is the verified build artifact above; opening a file
  //    in the editor is visual extra and the Quick Open path is focus-flaky, so
  //    it never fails the proof.
  let editorOpened = false;
  try {
    await focusWorkbench();
    await page.keyboard.press("ControlOrMeta+P");
    await expect(page.locator(".quick-input-widget")).toBeVisible({ timeout: 8_000 });
    await page.keyboard.type("hello.go");
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: /hello\.go/ })).toBeVisible({ timeout: 10_000 });
    editorOpened = true;
  } catch {
    // Non-fatal — the compile + artifact proof already passed.
  }
  await page.screenshot({ path: shot(editorOpened ? "03-editor.png" : "03-editor-skipped.png") });
});
