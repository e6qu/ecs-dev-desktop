// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decideImageSourceBuild,
  imageSourceConfigFromEnv,
  observationFromGithubPush,
  verifyGithubSignature,
} from "./image-source";

describe("decideImageSourceBuild", () => {
  it("starts a golden build when workspace image inputs changed", () => {
    expect(decideImageSourceBuild(["infra/images/base/entrypoint.sh"])).toEqual({
      decision: "build",
      reason: "workspace image inputs changed",
      target: "golden",
    });
    expect(decideImageSourceBuild(["scripts/publish-images.sh"]).decision).toBe("build");
  });

  it("skips when only control-plane files changed", () => {
    expect(decideImageSourceBuild(["apps/web/components/ImagesConsole.tsx"])).toEqual({
      decision: "skip",
      reason: "no workspace image inputs changed",
    });
  });
});

describe("imageSourceConfigFromEnv", () => {
  it("requires the repo and webhook secret", () => {
    expect(() => imageSourceConfigFromEnv({})).toThrow("EDD_IMAGE_SOURCE_REPO is required");
    expect(() =>
      imageSourceConfigFromEnv({ EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop" }),
    ).toThrow("EDD_IMAGE_SOURCE_WEBHOOK_SECRET is required");
  });

  it("loads the required webhook-only source sync coordinates", () => {
    expect(
      imageSourceConfigFromEnv({
        EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop",
        EDD_IMAGE_SOURCE_BRANCH: "main",
        EDD_IMAGE_SOURCE_WEBHOOK_SECRET: "secret",
      }),
    ).toEqual({
      repo: "e6qu/ecs-dev-desktop",
      branch: "main",
      webhookSecret: "secret",
    });
  });
});

describe("verifyGithubSignature", () => {
  it("accepts the GitHub sha256 HMAC and rejects tampering", () => {
    const body = '{"after":"abc"}';
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubSignature(`${body}\n`, signature, secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha1=bad", secret)).toBe(false);
  });
});

describe("observationFromGithubPush", () => {
  it("extracts a main-branch push for the configured repo", () => {
    const observation = observationFromGithubPush(
      {
        ref: "refs/heads/main",
        before: "old",
        after: "new",
        repository: { full_name: "e6qu/ecs-dev-desktop" },
        commits: [
          { added: ["infra/images/base/Dockerfile"], modified: ["README.md"] },
          { removed: ["infra/images/base/Dockerfile"], modified: ["pnpm-lock.yaml"] },
        ],
      },
      "e6qu/ecs-dev-desktop",
      "main",
    );
    expect(observation).toEqual({
      beforeSha: "old",
      afterSha: "new",
      changedPaths: ["README.md", "infra/images/base/Dockerfile", "pnpm-lock.yaml"],
      triggeredBy: "github-webhook",
    });
  });

  it("ignores other repos and branches", () => {
    expect(
      observationFromGithubPush(
        {
          ref: "refs/heads/feature",
          after: "new",
          repository: { full_name: "e6qu/ecs-dev-desktop" },
        },
        "e6qu/ecs-dev-desktop",
        "main",
      ),
    ).toBeNull();
  });
});
