// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression guard for the wake Lambda PACKAGING (not its logic — that's handler.test.ts).
//
// The Terraform module deploys this Lambda from a pre-built zip (var.wake_lambda_zip) with handler
// `index.handler` on `nodejs22.x`. That only works if the build emits `dist/index.mjs` (so the
// handler `index.<export>` resolves) AND produces the zip Terraform uploads. The build once emitted
// `dist/handler.mjs` with NO zip step, so the feature was undeployable; these assertions keep the
// build output tied to what the module expects so it can't silently regress.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { scripts?: { build?: string } };

describe("wake Lambda packaging (build ↔ Terraform handler contract)", () => {
  const build = pkg.scripts?.build ?? "";

  it("emits dist/index.mjs so the module's `index.handler` (index.<export>) resolves", () => {
    // The handler file basename must be `index` — the Terraform default handler is `index.handler`.
    expect(build).toContain("--outfile=dist/index.mjs");
    expect(build).not.toContain("dist/handler.mjs"); // the old, undeployable name
  });

  it("produces the wake-listener.zip the module uploads (var.wake_lambda_zip)", () => {
    expect(build).toMatch(/zip\b.*wake-listener\.zip\b.*index\.mjs/);
  });
});
