// SPDX-License-Identifier: AGPL-3.0-or-later
// Container entrypoint: read the workspace coordinates from the environment the control plane
// injects (EDD_WORKSPACE_ID, CONNECTION_TOKEN, …) and start the editor on :3000 under /w/<id>/.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_WORKSPACE_PROJECT_PATH, DEFAULT_WORKSPACE_PORT } from "@edd/config";

import { createEditorServer } from "./server";

const workspaceId = process.env.EDD_WORKSPACE_ID ?? "";
// The editor serves + opens the user's PROJECT dir (a clean subdir of the persisted volume), NOT
// the mount root or HOME — so editor/tool dotfiles under HOME never appear in the user's tree.
const root = process.env.EDD_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_PROJECT_PATH;
const port = Number(process.env.PORT ?? String(DEFAULT_WORKSPACE_PORT));
// The base path the server serves under. Normally `/w/<id>/` (matching the control-plane proxy),
// but overridable via EDD_BASE_PATH so the SAME server can run as a SIDECAR under a sub-path — e.g.
// the opencode terminal overlay serves at `/w/<id>/__edd_term/` on a second port. Always
// slash-terminated so `<base>terminal`/`<base>api/...` resolve correctly.
function normalizeBasePath(raw: string): string {
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.endsWith("/") ? withLead : `${withLead}/`;
}
const basePathOverride = process.env.EDD_BASE_PATH;
const basePath =
  basePathOverride !== undefined && basePathOverride !== ""
    ? normalizeBasePath(basePathOverride)
    : workspaceId === ""
      ? "/"
      : `/w/${workspaceId}/`;
// Behind the session-authorizing in-app proxy, the deployment disables the connection token for a
// tokenless browser URL; otherwise require the per-workspace CONNECTION_TOKEN the control plane
// injects (the same value the proxy hands the authenticated browser).
const token =
  process.env.EDD_DISABLE_CONNECTION_TOKEN === "1" ? undefined : process.env.CONNECTION_TOKEN;

// The SPA is bundled next to this server (dist/spa) at image build.
const spaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "spa");

// Optional command override for specialized terminal tabs; the Terminal workspace
// itself uses the user's normal shell with the agent CLIs on PATH.
const terminalCommand = process.env.EDD_TERMINAL_COMMAND;
const terminalOnly = process.env.EDD_TERMINAL_ONLY === "1";

const server = createEditorServer({
  root,
  basePath,
  spaDir,
  ...(token === undefined || token === "" ? {} : { token }),
  ...(terminalCommand === undefined || terminalCommand === "" ? {} : { terminalCommand }),
  ...(terminalOnly ? { terminalOnly } : {}),
});

server.listen(port, () => {
  const label = terminalOnly ? "Terminal workspace" : "Monaco editor";
  process.stdout.write(`edd: ${label} listening on :${String(port)}${basePath}\n`);
});
