// SPDX-License-Identifier: AGPL-3.0-or-later
import { revokeAuthSession } from "../lib/auth-sessions";

import {
  EDITORS,
  authJar,
  authSecret,
  cleanupSmokeWorkspaces,
  createWorkspace,
  openEditor,
  requiredEnv,
  waitEnabledImage,
  waitReady,
} from "./deployed-workspace-smoke-lib";

const baseUrl = requiredEnv("EDD_APP_URL").replace(/\/$/, "");
const region = requiredEnv("AWS_REGION");
const table = requiredEnv("DYNAMODB_TABLE");
const secretId = requiredEnv("AUTH_SECRET_ID");
const expectedSha = requiredEnv("EXPECTED_SHA");

process.env.DYNAMODB_TABLE = table;
process.env.AWS_REGION = region;

const secret = await authSecret(region, secretId);
const { jar, sessionId } = await authJar(secret, "smoke");
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
  revokeAuthSession(sessionId),
);
for (const failure of cleanupFailures) {
  console.error("edd: cleanup failure:", failure);
}
// A body failure is the primary signal — cleanup failures must never mask it.
if (bodyFailed) throw bodyError;
if (cleanupFailures.length > 0) {
  throw new Error(`workspace cleanup failed for ${String(cleanupFailures.length)} step(s)`);
}
