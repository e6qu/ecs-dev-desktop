// SPDX-License-Identifier: AGPL-3.0-or-later
import { GATEWAY_SECRET_ENV, workspaceGate } from "@edd/config";

import { createGate, type GateOptions } from "./gate";
import { makeUpstreamResolver } from "./upstream-resolver";

/**
 * Workspace gate entrypoint. Authorizes every request/upgrade against the
 * control-plane PDP, then forwards to the workspace upstream. Two modes:
 *  - DYNAMIC (production): `EDD_CONTROL_PLANE_URL` + `EDD_GATEWAY_SECRET` set —
 *    one gate fronts every workspace, waking + resolving each by subdomain.
 *  - STATIC: `EDD_WORKSPACE_UPSTREAM_URL` — a single fixed upstream (tests/dev).
 */
const gatewaySecret = process.env[GATEWAY_SECRET_ENV];
const controlPlaneUrl = workspaceGate.controlPlaneUrl;
const staticUpstream = workspaceGate.upstreamUrl;

let opts: GateOptions;
let target: string;
if (
  controlPlaneUrl !== undefined &&
  controlPlaneUrl.length > 0 &&
  gatewaySecret !== undefined &&
  gatewaySecret.length > 0
) {
  // Dynamic: one gate fronts every workspace, waking + resolving each by host.
  opts = {
    pdpUrl: workspaceGate.pdpUrl,
    resolveUpstream: makeUpstreamResolver({ controlPlaneUrl, gatewaySecretHex: gatewaySecret }),
  };
  target = `${controlPlaneUrl} (dynamic per-workspace)`;
} else if (staticUpstream !== undefined && staticUpstream.length > 0) {
  opts = { pdpUrl: workspaceGate.pdpUrl, upstreamUrl: staticUpstream };
  target = staticUpstream;
} else {
  throw new Error(
    "workspace-gate requires EDD_CONTROL_PLANE_URL+EDD_GATEWAY_SECRET (dynamic) or EDD_WORKSPACE_UPSTREAM_URL (static)",
  );
}

const server = createGate(opts);
server.listen(workspaceGate.port, () => {
  console.log(`workspace-gate listening on :${String(workspaceGate.port)} → ${target}`);
});
