// SPDX-License-Identifier: AGPL-3.0-or-later
// Local dev bootstrap: ensure the DynamoDB table exists and seed the enabled base
// images, so `next dev` against DynamoDB Local has a usable control plane out of
// the box. Idempotent — safe to re-run; targets whatever DYNAMODB_ENDPOINT points
// at (DynamoDB Local by default). Invoked by scripts/dev.sh.
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, ensureTable, makeBaseImageEntity, TABLE } from "@edd/db";

// The default golden catalog (mirrors `golden_image_repos` in the Terraform
// example). Locally these are catalog entries the fakes launch from; in the cloud
// they point at the golden ECR repos.
const DEV_IMAGES: readonly { name: string; image: string }[] = [
  { name: "Node 20", image: "golden/node:20" },
  { name: "Go 1.22", image: "golden/go:1.22" },
  { name: "Python 3.12", image: "golden/python:3.12" },
];

const table = process.env.DYNAMODB_TABLE ?? TABLE;
const client = createDynamoClient();

await ensureTable(client, table);

const catalog = new CatalogService({
  baseImages: makeBaseImageEntity(client, table),
  clock: systemClock,
});
if ((await catalog.list()).length === 0) {
  for (const { name, image } of DEV_IMAGES) {
    await catalog.create({ name, image: baseImage(image) });
  }
  process.stdout.write(`dev-bootstrap: seeded ${DEV_IMAGES.length.toString()} base images\n`);
}
process.stdout.write(`dev-bootstrap: ready (table ${table})\n`);
