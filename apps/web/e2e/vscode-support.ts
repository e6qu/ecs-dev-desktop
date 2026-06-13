// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared constants + helpers for the OpenVSCode workspace browser proof
// (playwright.vscode.config.ts). The golden workspace image is run as a
// container with its OpenVSCode HTTP port published; the test drives the real
// workbench in a browser and verifies an in-workspace compile.
import { execFileSync } from "node:child_process";

export const VSCODE_IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";
export const VSCODE_CONTAINER = "edd-vscode-pw";
export const VSCODE_HOST_PORT = 13000;
/** A known connection token so the test can open the workbench (OpenVSCode
 * requires `?tkn=`); a random per-boot token would be unreachable. */
export const VSCODE_TOKEN = "edd-vscode-e2e-token";
export const VSCODE_BASE_URL = `http://127.0.0.1:${String(VSCODE_HOST_PORT)}`;
export const VSCODE_URL = `${VSCODE_BASE_URL}/?tkn=${VSCODE_TOKEN}`;

/** Run a login-shell command inside the workspace container as the `workspace`
 * user (login shell ⇒ the toolchain PATH from /etc/profile.d is present), return
 * stdout. Throws on non-zero exit. */
export function inWorkspace(cmd: string): string {
  return execFileSync("docker", ["exec", "-u", "workspace", VSCODE_CONTAINER, "bash", "-lc", cmd], {
    encoding: "utf8",
  });
}
