// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BuildLogChunkDto, ImageMetadataDto } from "@edd/api-contracts";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeImageSourceEntity,
  makeImageSourceTriggerEntity,
} from "@edd/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildObservation, BuildSummary, ImageOps, StartImageBuildInput } from "./image-ops";
import { ImageSourceService, type SourceObservation } from "./image-source";

const TEST_TABLE = "ecs-dev-desktop-image-source-integ";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

class FakeImageOps implements ImageOps {
  readonly starts: StartImageBuildInput[] = [];
  build: BuildObservation | null = { status: "succeeded" };
  readonly images = new Set<string>();

  getImageMetadata(repo: string, tag: string): Promise<ImageMetadataDto | null> {
    if (!this.images.has(`${repo}:${tag}`)) return Promise.resolve(null);
    return Promise.resolve({
      repo,
      tag,
      digest: `sha256:${tag}`,
      compressedBytes: 1,
      layerCount: 1,
      layers: [{ digest: `sha256:layer-${tag}`, sizeBytes: 1 }],
    });
  }

  listImageTags(_repo: string, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }

  startBuild(input: StartImageBuildInput): Promise<string> {
    this.starts.push(input);
    return Promise.resolve("manual-build");
  }

  getBuild(_buildId: string): Promise<BuildObservation | null> {
    return Promise.resolve(this.build);
  }

  listRecentBuilds(_limit: number): Promise<BuildSummary[]> {
    return Promise.resolve([]);
  }

  getBuildLogs(_observation: BuildObservation, _nextToken?: string): Promise<BuildLogChunkDto> {
    return Promise.resolve({ lines: [] });
  }
}

const observation: SourceObservation = {
  beforeSha: "0000000000000000000000000000000000000000",
  afterSha: "1234567890abcdef1234567890abcdef12345678",
  changedPaths: ["infra/images/base/Dockerfile"],
  triggeredBy: "github-webhook",
};

function service(args: {
  readonly imageOps: FakeImageOps;
  readonly roll: (repo: string, tag: string) => Promise<void>;
  readonly now?: () => Date;
}): ImageSourceService {
  const client = createDynamoClient();
  return new ImageSourceService({
    sources: makeImageSourceEntity(client, TEST_TABLE),
    triggers: makeImageSourceTriggerEntity(client, TEST_TABLE),
    imageOps: () => args.imageOps,
    rollCatalogImageTag: args.roll,
    cfg: {
      repo: "e6qu/ecs-dev-desktop",
      branch: "main",
      webhookSecret: "secret",
      appName: "edd-prod",
      goldenVariants: ["omnibus", "python"],
    },
    now: args.now ?? (() => new Date("2026-07-07T12:00:00.000Z")),
  });
}

function advancingClock(): () => Date {
  let now = Date.parse("2026-07-07T12:00:00.000Z");
  return () => {
    const current = new Date(now);
    now += 1_000;
    return current;
  };
}

function publishGoldenImages(ops: FakeImageOps, tag: string): void {
  ops.images.add(`edd-prod/golden/omnibus:${tag}`);
  ops.images.add(`edd-prod/golden/python:${tag}`);
}

describe("ImageSourceService catalog rollout", () => {
  const client = createDynamoClient();

  beforeEach(async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("rolls every configured golden catalog repo after GitHub Actions publishes the tag", async () => {
    const ops = new FakeImageOps();
    const rolled: string[] = [];
    const svc = service({
      imageOps: ops,
      roll: (repo, tag) => {
        rolled.push(`${repo}:${tag}`);
        return Promise.resolve();
      },
    });

    const trigger = await svc.handleObservation(observation);
    expect(trigger.status).toBe("queued");
    expect(trigger.buildId).toBeUndefined();
    expect(ops.starts).toHaveLength(0);

    await svc.reconcileRecentBuilds();
    let state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "building",
      reason: "waiting for golden image tag from GitHub Actions workflow",
    });

    publishGoldenImages(ops, "1234567890ab");
    await svc.reconcileRecentBuilds();

    expect(rolled).toEqual([
      "edd-prod/golden/omnibus:1234567890ab",
      "edd-prod/golden/python:1234567890ab",
    ]);
    state = await svc.state();
    expect(state.triggers[0]).toMatchObject({ status: "succeeded", tag: "1234567890ab" });
  });

  it("marks the trigger failed when catalog rollout fails", async () => {
    const ops = new FakeImageOps();
    const svc = service({
      imageOps: ops,
      roll: () => {
        return Promise.reject(
          new Error("no catalog entry points at image repo edd-prod/golden/omnibus"),
        );
      },
    });

    await svc.handleObservation(observation);
    publishGoldenImages(ops, "1234567890ab");
    await svc.reconcileRecentBuilds();

    const state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "failed",
      reason:
        "catalog rollout failed: no catalog entry points at image repo edd-prod/golden/omnibus",
    });
  });

  it("rolls only the newest successful golden build when pending builds overlap", async () => {
    const ops = new FakeImageOps();
    const rolled: string[] = [];
    const svc = service({
      imageOps: ops,
      roll: (repo, tag) => {
        rolled.push(`${repo}:${tag}`);
        return Promise.resolve();
      },
      now: advancingClock(),
    });

    await svc.handleObservation(observation);
    await svc.handleObservation({
      ...observation,
      beforeSha: observation.afterSha,
      afterSha: "abcdef1234567890abcdef1234567890abcdef12",
    });
    publishGoldenImages(ops, "1234567890ab");
    publishGoldenImages(ops, "abcdef123456");
    await svc.reconcileRecentBuilds();

    expect(rolled).toEqual([
      "edd-prod/golden/omnibus:abcdef123456",
      "edd-prod/golden/python:abcdef123456",
    ]);
    const state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "succeeded",
      tag: "abcdef123456",
      reason: "workspace image inputs changed",
    });
    expect(state.triggers[1]).toMatchObject({
      status: "succeeded",
      tag: "1234567890ab",
      reason: "superseded by newer successful golden build",
    });
  });

  it("does not roll an older tag while a newer source trigger is still unpublished", async () => {
    const ops = new FakeImageOps();
    const rolled: string[] = [];
    const svc = service({
      imageOps: ops,
      roll: (repo, tag) => {
        rolled.push(`${repo}:${tag}`);
        return Promise.resolve();
      },
      now: advancingClock(),
    });

    await svc.handleObservation(observation);
    await svc.handleObservation({
      ...observation,
      beforeSha: observation.afterSha,
      afterSha: "abcdef1234567890abcdef1234567890abcdef12",
    });
    publishGoldenImages(ops, "1234567890ab");

    await svc.reconcileRecentBuilds();

    expect(rolled).toEqual([]);
    const state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "building",
      tag: "abcdef123456",
      reason: "waiting for golden image tag from GitHub Actions workflow",
    });
    expect(state.triggers[1]).toMatchObject({
      status: "succeeded",
      tag: "1234567890ab",
      reason: "superseded by newer successful golden build",
    });
  });

  it("retries catalog rollout failures and converges the newest successful build", async () => {
    const ops = new FakeImageOps();
    const rolled: string[] = [];
    let failRollout = true;
    const svc = service({
      imageOps: ops,
      roll: (repo, tag) => {
        if (failRollout) {
          return Promise.reject(new Error(`rollout of ${repo} lost a concurrent update`));
        }
        rolled.push(`${repo}:${tag}`);
        return Promise.resolve();
      },
      now: advancingClock(),
    });

    await svc.handleObservation(observation);
    await svc.handleObservation({
      ...observation,
      beforeSha: observation.afterSha,
      afterSha: "fedcba9876543210fedcba9876543210fedcba98",
    });
    publishGoldenImages(ops, "1234567890ab");
    publishGoldenImages(ops, "fedcba987654");

    await svc.reconcileRecentBuilds();
    let state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "failed",
      tag: "fedcba987654",
      reason: "catalog rollout failed: rollout of edd-prod/golden/omnibus lost a concurrent update",
    });

    failRollout = false;
    await svc.reconcileRecentBuilds();

    expect(rolled).toEqual([
      "edd-prod/golden/omnibus:fedcba987654",
      "edd-prod/golden/python:fedcba987654",
    ]);
    state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "succeeded",
      tag: "fedcba987654",
      reason: "workspace image inputs changed",
    });
    expect(state.triggers[1]).toMatchObject({
      status: "succeeded",
      tag: "1234567890ab",
      reason: "superseded by newer successful golden build",
    });
  });
});
