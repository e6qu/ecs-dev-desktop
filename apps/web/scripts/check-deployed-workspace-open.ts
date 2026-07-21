// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EDITORS,
  cleanupSmokeWorkspaces,
  createWorkspace,
  openEditor,
  requiredEnv,
  waitEnabledImage,
  waitReady,
} from "./deployed-workspace-smoke-lib";
import { signInToDeployedApp, signOutOfDeployedApp } from "./deployed-shauth-session";

const baseUrl = requiredEnv("EDD_APP_URL").replace(/\/$/, "");
const expectedSha = requiredEnv("EXPECTED_SHA");
const session = await signInToDeployedApp(
  baseUrl,
  requiredEnv("SHAUTH_ISSUER"),
  requiredEnv("SHAUTH_USERNAME"),
  requiredEnv("SHAUTH_PASSWORD"),
);
const jar = session.applicationCookies;
const created: string[] = [];

let bodyFailed = false;
let bodyError: unknown;
try {
  const baseImage = await waitEnabledImage(baseUrl, jar, expectedSha);
  for (const editor of EDITORS) {
    const id = await createWorkspace(baseUrl, jar, baseImage, editor);
    created.push(id);
    await waitReady(baseUrl, jar, id);
    await openEditor(baseUrl, jar, id, editor);
    console.log(`edd: ${editor} workspace opened through public app (${id})`);
  }
} catch (e) {
  bodyFailed = true;
  bodyError = e;
}

const cleanupFailures = await cleanupSmokeWorkspaces(baseUrl, jar, created, () =>
  signOutOfDeployedApp(baseUrl, session),
);
for (const failure of cleanupFailures) {
  console.error("edd: cleanup failure:", failure);
}
// A body failure is the primary signal — cleanup failures must never mask it.
if (bodyFailed) throw bodyError;
if (cleanupFailures.length > 0) {
  throw new Error(`workspace cleanup failed for ${String(cleanupFailures.length)} step(s)`);
}
