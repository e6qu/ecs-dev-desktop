// SPDX-License-Identifier: AGPL-3.0-or-later
// Local dev bootstrap: ensure the DynamoDB table exists and seed one enabled base
// image, so `next dev` against DynamoDB Local has a usable control plane out of
// the box. Idempotent — safe to re-run; targets whatever DYNAMODB_ENDPOINT points
// at (DynamoDB Local by default). Invoked by scripts/dev.sh.
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, ensureTable, makeBaseImageEntity, TABLE } from "@edd/db";

const DEV_IMAGE = "golden/node:20";

const table = process.env.DYNAMODB_TABLE ?? TABLE;
const client = createDynamoClient();

await ensureTable(client, table);

const catalog = new CatalogService({
  baseImages: makeBaseImageEntity(client, table),
  clock: systemClock,
});
if ((await catalog.list()).length === 0) {
  await catalog.create({ name: "Node 20", image: baseImage(DEV_IMAGE) });
  process.stdout.write(`dev-bootstrap: seeded base image ${DEV_IMAGE}\n`);
}
process.stdout.write(`dev-bootstrap: ready (table ${table})\n`);
