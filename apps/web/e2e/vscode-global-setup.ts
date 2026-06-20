// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";

import {
  VSCODE_CONTAINER,
  VSCODE_HOST_PORT,
  VSCODE_IMAGE,
  VSCODE_ROOT_URL,
  VSCODE_TOKEN,
  VSCODE_WORKSPACE_ID,
} from "./vscode-support";

/**
 * Launch the golden workspace image as a container with OpenVSCode's HTTP port
 * published, and wait until the workbench serves. The image is the real product
 * image (`edd-workspace:e2e`); only the reach (published port vs awsvpc ENI)
 * differs — the ECS/managed-EBS wrapping is covered by the e2e tier.
 */
export default async function globalSetup(): Promise<void> {
  execFileSync("docker", ["rm", "-f", VSCODE_CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    VSCODE_CONTAINER,
    "-p",
    `${String(VSCODE_HOST_PORT)}:3000`,
    "-e",
    `EDD_WORKSPACE_ID=${VSCODE_WORKSPACE_ID}`,
    "-e",
    "EDD_CONTROL_PLANE_URL=http://127.0.0.1:9",
    "-e",
    "EDD_AGENT_TOKEN=edd-vscode-agent-token",
    "-e",
    `CONNECTION_TOKEN=${VSCODE_TOKEN}`,
    VSCODE_IMAGE,
  ]);

  // OpenVSCode is ready once it answers HTTP under its server base path. Without the
  // token cookie (Node fetch has no cookie jar) the workbench root returns 403 — its
  // token gate — which still proves the server is serving; a real browser (the test)
  // follows the token 302 + cookie to the 200 workbench.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(VSCODE_ROOT_URL, { redirect: "manual" });
      if ([200, 302, 403].includes(res.status)) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      const logs = execFileSync("docker", ["logs", "--tail", "40", VSCODE_CONTAINER], {
        encoding: "utf8",
      });
      throw new Error(`OpenVSCode did not become ready:\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
