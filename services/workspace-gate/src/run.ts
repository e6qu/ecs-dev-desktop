// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceGate } from "@edd/config";

import { createGate } from "./gate";

/**
 * Workspace gate entrypoint. Listens on the configured port and authorizes every
 * request/upgrade against the control-plane PDP before forwarding to the
 * workspace upstream. `EDD_WORKSPACE_UPSTREAM_URL` is required (the upstream is
 * deployment-specific); `EDD_WORKSPACE_PDP_URL` and `EDD_POMERIUM_JWKS_URL`
 * configure the decision path.
 */
const upstreamUrl = workspaceGate.upstreamUrl;
if (upstreamUrl === undefined || upstreamUrl.length === 0) {
  throw new Error("EDD_WORKSPACE_UPSTREAM_URL is required");
}

const server = createGate({ pdpUrl: workspaceGate.pdpUrl, upstreamUrl });
server.listen(workspaceGate.port, () => {
  console.log(`workspace-gate listening on :${String(workspaceGate.port)} → ${upstreamUrl}`);
});
