// SPDX-License-Identifier: AGPL-3.0-or-later
// Local dev bootstrap: ensure the DynamoDB table exists and seed the enabled base
// images, so `next dev` against DynamoDB Local has a usable control plane out of
// the box. Idempotent — safe to re-run; targets whatever DYNAMODB_ENDPOINT points
// at (DynamoDB Local by default). Invoked by scripts/dev.sh.
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, ensureTable, makeBaseImageEntity, TABLE } from "@edd/db";

// The default golden catalog = the image collection (a shared base + omnibus and
// slim per-language variants; see infra/images). Locally these are catalog entries
// the fakes launch from; in the cloud they point at the golden ECR repos.
const DEV_IMAGES: readonly {
  name: string;
  image: string;
  description: string;
  tags: readonly string[];
  tools: readonly string[];
}[] = [
  {
    name: "Omnibus (all languages)",
    image: "golden/omnibus",
    description: "Full polyglot workspace with every curated language toolchain and agent.",
    tags: ["polyglot", "full", "agents"],
    tools: ["claude", "codex", "trivy", "pnpm", "go", "python3", "javac", "cargo"],
  },
  {
    name: "TypeScript / Node",
    image: "golden/typescript",
    description: "Lean Node and TypeScript environment for app and tooling work.",
    tags: ["typescript", "node", "slim"],
    tools: ["pnpm", "eslint", "prettier", "trivy"],
  },
  {
    name: "Python",
    image: "golden/python",
    description: "Python runtime with the repo's lint, type, and security tools baked in.",
    tags: ["python", "slim"],
    tools: ["python3", "uv", "ruff", "semgrep"],
  },
  {
    name: "Go",
    image: "golden/go",
    description: "Go workspace with the static analysis set used in CI.",
    tags: ["go", "slim"],
    tools: ["go", "golangci-lint", "staticcheck", "trivy"],
  },
  {
    name: "Java",
    image: "golden/java",
    description: "JDK workspace with build tooling and the standard formatter.",
    tags: ["java", "slim"],
    tools: ["javac", "mvn", "gradle", "google-java-format"],
  },
  {
    name: "Rust",
    image: "golden/rust",
    description: "Rust toolchain with linting and dependency-audit coverage.",
    tags: ["rust", "slim"],
    tools: ["cargo", "clippy", "cargo-audit", "trivy"],
  },
];

const table = process.env.DYNAMODB_TABLE ?? TABLE;
const client = createDynamoClient();

await ensureTable(client, table);

const catalog = new CatalogService({
  baseImages: makeBaseImageEntity(client, table),
  clock: systemClock,
});
if ((await catalog.list()).length === 0) {
  for (const { name, image, description, tags, tools } of DEV_IMAGES) {
    await catalog.create({ name, image: baseImage(image), description, tags, tools });
  }
  process.stdout.write(`dev-bootstrap: seeded ${DEV_IMAGES.length.toString()} base images\n`);
}
process.stdout.write(`dev-bootstrap: ready (table ${table})\n`);
