// SPDX-License-Identifier: AGPL-3.0-or-later
import { revokeAuthSession } from "../lib/auth-sessions";

import {
  EDITORS,
  authJar,
  authSecret,
  createWorkspace,
  deleteWorkspace,
  openEditor,
  purgeWorkspace,
  requiredEnv,
  waitPurged,
  waitTerminated,
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
try {
  const baseImage = await waitEnabledImage(baseUrl, jar, expectedSha);
  for (const editor of EDITORS) {
    const id = await createWorkspace(baseUrl, jar, baseImage, editor);
    created.push(id);
    await waitReady(baseUrl, jar, id);
    await openEditor(baseUrl, jar, id, editor);
    console.log(`edd: ${editor} workspace opened through public app (${id})`);
  }
} finally {
  await Promise.all(
    created.map(async (id) => {
      await deleteWorkspace(baseUrl, jar, id);
      await waitTerminated(baseUrl, jar, id);
      await purgeWorkspace(baseUrl, jar, id);
      await waitPurged(baseUrl, jar, id);
    }),
  );
  await revokeAuthSession(sessionId);
}
