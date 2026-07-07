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

  getImageMetadata(_repo: string, _tag: string): Promise<ImageMetadataDto | null> {
    return Promise.resolve(null);
  }

  listImageTags(_repo: string, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }

  startBuild(input: StartImageBuildInput): Promise<string> {
    this.starts.push(input);
    return Promise.resolve("build-1");
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
    now: () => new Date("2026-07-07T12:00:00.000Z"),
  });
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

  it("rolls every configured golden catalog repo after a successful build", async () => {
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
    expect(ops.starts).toHaveLength(1);

    await svc.reconcileRecentBuilds();

    expect(rolled).toEqual([
      "edd-prod/golden/omnibus:1234567890ab",
      "edd-prod/golden/python:1234567890ab",
    ]);
    const state = await svc.state();
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
    await svc.reconcileRecentBuilds();

    const state = await svc.state();
    expect(state.triggers[0]).toMatchObject({
      status: "failed",
      reason:
        "catalog rollout failed: no catalog entry points at image repo edd-prod/golden/omnibus",
    });
  });
});
