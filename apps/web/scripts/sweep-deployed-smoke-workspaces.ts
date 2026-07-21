// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  authenticatedOwnerId,
  requiredEnv,
  sweepSmokeWorkspaces,
} from "./deployed-workspace-smoke-lib";
import { signInToDeployedApp, signOutOfDeployedApp } from "./deployed-shauth-session";

const baseUrl = requiredEnv("EDD_APP_URL").replace(/\/$/, "");
const session = await signInToDeployedApp(
  baseUrl,
  requiredEnv("SHAUTH_ISSUER"),
  requiredEnv("SHAUTH_USERNAME"),
  requiredEnv("SHAUTH_PASSWORD"),
);

const { swept, failures } = await (async () => {
  try {
    const ownerId = await authenticatedOwnerId(baseUrl, session.applicationCookies);
    const result = await sweepSmokeWorkspaces(baseUrl, session.applicationCookies, [ownerId]);
    for (const id of result.swept) console.log(`edd: swept leftover smoke workspace ${id}`);
    return result;
  } finally {
    await signOutOfDeployedApp(baseUrl, session);
  }
})();
if (failures.length > 0) {
  for (const failure of failures) console.error("edd: sweep failure:", failure);
  throw new Error(`failed to sweep ${String(failures.length)} deployed smoke workspace(s)`);
}
if (swept.length === 0) console.log("edd: no leftover smoke workspaces");
