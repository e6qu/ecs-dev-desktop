// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decideImageSourceBuild,
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  imageSourceConfigFromEnv,
  observationFromGithubCommit,
  observationFromGithubPush,
  validateGithubWebhookBody,
  validateGithubWebhookHeaders,
  verifyGithubSignature,
} from "./image-source";

const delivery = "123e4567-e89b-42d3-a456-426614174000";

function webhookHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": "push",
    ...extra,
  });
}

describe("decideImageSourceBuild", () => {
  it("tracks every main push as a CI-published golden image candidate", () => {
    expect(decideImageSourceBuild(["infra/images/base/entrypoint.sh"])).toEqual({
      decision: "build",
      reason: "main push publishes golden images",
      target: "golden",
    });
    expect(decideImageSourceBuild(["apps/web/components/ImagesConsole.tsx"])).toEqual({
      decision: "build",
      reason: "main push publishes golden images",
      target: "golden",
    });
  });
});

describe("imageSourceConfigFromEnv", () => {
  it("requires the repo and webhook secret", () => {
    expect(() => imageSourceConfigFromEnv({})).toThrow("EDD_IMAGE_SOURCE_REPO is required");
    expect(() =>
      imageSourceConfigFromEnv({ EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop" }),
    ).toThrow("EDD_IMAGE_SOURCE_WEBHOOK_SECRET is required");
    expect(() =>
      imageSourceConfigFromEnv({
        EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop",
        EDD_IMAGE_SOURCE_WEBHOOK_SECRET: "secret",
      }),
    ).toThrow("EDD_APP_NAME is required");
    expect(() =>
      imageSourceConfigFromEnv({
        EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop",
        EDD_IMAGE_SOURCE_WEBHOOK_SECRET: "secret",
        EDD_APP_NAME: "edd-prod",
      }),
    ).toThrow("EDD_GOLDEN is required");
    expect(() =>
      imageSourceConfigFromEnv({
        EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop",
        EDD_IMAGE_SOURCE_WEBHOOK_SECRET: "secret",
        EDD_APP_NAME: "edd-prod",
        EDD_GOLDEN: "omnibus",
      }),
    ).toThrow("EDD_IMAGE_SOURCE_BRANCH is required");
  });

  it("loads the required webhook-only source sync coordinates", () => {
    expect(
      imageSourceConfigFromEnv({
        EDD_IMAGE_SOURCE_REPO: "e6qu/ecs-dev-desktop",
        EDD_IMAGE_SOURCE_BRANCH: "main",
        EDD_IMAGE_SOURCE_WEBHOOK_SECRET: "secret",
        EDD_APP_NAME: "edd-prod",
        EDD_GOLDEN: "omnibus python",
        AUTH_GITHUB_API_URL: "https://github.enterprise/api/v3/",
      }),
    ).toEqual({
      repo: "e6qu/ecs-dev-desktop",
      branch: "main",
      webhookSecret: "secret",
      appName: "edd-prod",
      goldenVariants: ["omnibus", "python"],
      githubApiUrl: "https://github.enterprise/api/v3",
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

describe("validateGithubWebhookHeaders", () => {
  it("accepts the narrow GitHub push webhook envelope", () => {
    expect(validateGithubWebhookHeaders(webhookHeaders())).toBeNull();
    expect(
      validateGithubWebhookHeaders(
        webhookHeaders({ "content-type": "application/json; charset=utf-8" }),
      ),
    ).toBeNull();
  });

  it("rejects unsupported events, missing delivery ids, wrong content type, and oversized declared bodies", () => {
    expect(validateGithubWebhookHeaders(webhookHeaders({ "x-github-event": "ping" }))).toEqual({
      status: 400,
      error: "unsupported event",
    });
    expect(
      validateGithubWebhookHeaders(webhookHeaders({ "x-github-delivery": "not-a-uuid" })),
    ).toEqual({
      status: 400,
      error: "invalid delivery id",
    });
    expect(validateGithubWebhookHeaders(webhookHeaders({ "content-type": "text/plain" }))).toEqual({
      status: 400,
      error: "content-type must be application/json",
    });
    expect(
      validateGithubWebhookHeaders(
        webhookHeaders({ "content-length": String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) }),
      ),
    ).toEqual({ status: 413, error: "payload too large" });
  });
});

describe("validateGithubWebhookBody", () => {
  it("requires a valid HMAC over the raw body", () => {
    const body = '{"after":"abc"}';
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(validateGithubWebhookBody(body, signature, secret)).toBeNull();
    expect(validateGithubWebhookBody(`${body}\n`, signature, secret)).toEqual({
      status: 401,
      error: "invalid signature",
    });
  });

  it("rejects oversized raw bodies even when content-length was absent", () => {
    const body = "x".repeat(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1);
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(validateGithubWebhookBody(body, signature, secret)).toEqual({
      status: 413,
      error: "payload too large",
    });
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

describe("observationFromGithubCommit", () => {
  it("extracts the latest branch commit from GitHub's standard commit API", () => {
    expect(
      observationFromGithubCommit({
        sha: "new",
        parents: [{ sha: "old" }],
        files: [{ filename: "apps/web/server.ts" }, { filename: "infra/images/base/Dockerfile" }],
      }),
    ).toEqual({
      beforeSha: "old",
      afterSha: "new",
      changedPaths: ["apps/web/server.ts", "infra/images/base/Dockerfile"],
      triggeredBy: "github-poll",
    });
  });

  it("rejects malformed commit API payloads", () => {
    expect(observationFromGithubCommit({})).toBeNull();
    expect(observationFromGithubCommit({ sha: "" })).toBeNull();
  });
});
