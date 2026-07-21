// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";

import { requiredEnv } from "./deployed-workspace-smoke-lib";
import { signInToDeployedApp, signOutOfDeployedApp } from "./deployed-shauth-session";

const applicationUrl = requiredEnv("EDD_APP_URL");
const session = await signInToDeployedApp(
  applicationUrl,
  requiredEnv("SHAUTH_ISSUER"),
  requiredEnv("SHAUTH_USERNAME"),
  requiredEnv("SHAUTH_PASSWORD"),
);
const cookie = session.applicationCookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
const authenticated = await fetch(`${applicationUrl}/api/workspaces`, { headers: { cookie } });
assert.equal(authenticated.status, 200, await authenticated.text());

await signOutOfDeployedApp(applicationUrl, session);
const revoked = await fetch(`${applicationUrl}/api/workspaces`, { headers: { cookie } });
assert.equal(
  revoked.status,
  401,
  `logout left the retained app cookie open: ${await revoked.text()}`,
);

console.log("edd: deployed Shauth browser-session integration passed");
