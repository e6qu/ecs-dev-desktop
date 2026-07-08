// SPDX-License-Identifier: AGPL-3.0-or-later
// First-party EDD workspace extension, baked into OpenVSCode's built-in
// extensions dir by the golden base image (infra/images/base/Dockerfile).
// Plain CommonJS on purpose -- no build step, the folder is loaded as-is.
//
// What it does (all runtime-config-driven, nothing hardcoded per environment):
//   1. "EDD home" control -> back to the portal. The portal URL comes from the
//      container's own EDD_CONTROL_PLANE_URL (the same coordinate the idle-agent
//      heartbeats to), so the link is correct in every deployment by construction.
//   2. A prominent, always-visible "Open terminal (Ctrl+`)" control -- VS Code
//      exposes no public API for injecting items into the window title bar next
//      to the chat entries, so these live in the status bar (right-aligned, top
//      priority), the sanctioned always-visible surface for extension controls.
//   3. Opens an interactive terminal on startup when none is open yet.
//   4. Opens the selected vendor UI when EDD_EDITOR_MODE is claude/codex.
//   5. A once-per-workspace tip that the claude/codex OAuth browser redirect
//      cannot reach a remote workspace -- paste the code shown in the browser
//      instead (both CLIs support that flow natively).
"use strict";

const fs = require("node:fs");
const vscode = require("vscode");

// Editor activity marker: touched (throttled) on real editor interaction so the
// idle-agent (infra/images/base/idle-agent.sh, which also watches /dev/pts/* and
// CPU load) can tell "in use" from "merely running" — the reconciler only keeps
// ACTIVE workspaces from scaling to zero. tmpfs path, container-local.
const ACTIVITY_MARKER = "/tmp/edd-activity";
const ACTIVITY_TOUCH_THROTTLE_MS = 30_000;

const OAUTH_TIP_SHOWN_KEY = "edd.oauthTipShown";
const OAUTH_TIP =
  "Tip: when 'claude' or 'codex' asks you to sign in, the browser redirect can't reach " +
  "this remote workspace — paste the code shown in the browser instead of waiting for it.";

const VENDOR_COMMANDS = {
  claude: "claude-vscode.editor.open",
  codex: "chatgpt.openSidebar",
};

/** The portal URL from the workspace container's environment, or null when the
 * coordinate is absent (e.g. a bare local `docker run` without the platform). */
function portalUrl() {
  const base = process.env.EDD_CONTROL_PLANE_URL;
  if (!base) return null;
  try {
    return new URL("/workspaces", base).toString();
  } catch {
    return null;
  }
}

function activate(context) {
  const portal = portalUrl();
  if (portal !== null) {
    context.subscriptions.push(
      vscode.commands.registerCommand("edd.openPortal", () =>
        vscode.env.openExternal(vscode.Uri.parse(portal)),
      ),
    );
    const home = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10_000);
    home.text = "$(home) EDD home";
    home.tooltip = "Back to the EDD portal (your workspaces)";
    home.command = "edd.openPortal";
    home.show();
    context.subscriptions.push(home);
  }

  const term = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9_999);
  term.text = "$(terminal) Open terminal (Ctrl+`)";
  term.tooltip = "Toggle the integrated terminal (Ctrl+` / +Shift for a new one)";
  term.command = "workbench.action.terminal.toggleTerminal";
  term.show();
  context.subscriptions.push(term);

  // Open an interactive terminal by default -- but never stack a duplicate onto
  // a window reload that already has one.
  if (vscode.window.terminals.length === 0) {
    vscode.window.createTerminal().show(/* preserveFocus */ true);
  }

  const vendorCommand = VENDOR_COMMANDS[process.env.EDD_EDITOR_MODE];
  if (vendorCommand !== undefined) {
    void vscode.commands.executeCommand(vendorCommand).then(
      () => undefined,
      (err) => {
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "unknown command failure";
        void vscode.window.showErrorMessage(
          `EDD could not open the ${process.env.EDD_EDITOR_MODE} vendor UI: ${message}`,
        );
        console.error(`edd: vendor UI command ${vendorCommand} failed: ${message}`);
      },
    );
  }

  // The OAuth tip once per workspace (persisted in globalState on the EBS home
  // volume), not on every reload -- informative once, noise forever after.
  if (context.globalState.get(OAUTH_TIP_SHOWN_KEY) !== true) {
    void context.globalState.update(OAUTH_TIP_SHOWN_KEY, true);
    void vscode.window.showInformationMessage(OAUTH_TIP);
  }

  // Editor activity -> the marker the idle-agent watches. Throttled: interaction
  // events fire per keystroke/cursor move, one touch per window is plenty.
  let lastTouch = 0;
  const touchActivity = () => {
    const now = Date.now();
    if (now - lastTouch < ACTIVITY_TOUCH_THROTTLE_MS) return;
    lastTouch = now;
    try {
      fs.writeFileSync(ACTIVITY_MARKER, "");
    } catch {
      // Best-effort: a missing/readonly /tmp must never break the editor; the
      // idle-agent's PTY + CPU signals still cover most real usage.
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(touchActivity),
    vscode.window.onDidChangeTextEditorSelection(touchActivity),
    vscode.window.onDidChangeActiveTextEditor(touchActivity),
    vscode.window.onDidOpenTerminal(touchActivity),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) touchActivity();
    }),
  );
  // The client just connected to load this window -- that's usage too.
  touchActivity();
}

function deactivate() {}

module.exports = { activate, deactivate };
