// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  BuildStatusDto,
  BuildTargetDto,
  ImageSourceStateDto,
  ImageSourceTriggerDto,
  ImageSourceTriggerStatusDto,
} from "@edd/api-contracts";
import {
  createDynamoClient,
  makeImageSourceEntity,
  makeImageSourceTriggerEntity,
  type ImageSourceEntity,
  type ImageSourceTriggerEntity,
} from "@edd/db";

import { getImageOps, type ImageOps } from "./image-ops";
import { tableName } from "./control-plane";

const SOURCE_SCHEMA_VERSION = 2;
const SOURCE_ID = "github-main";
const DEFAULT_BRANCH = "main";
const BUILD_TRIGGER = "edd-github-source";
const RECENT_TRIGGER_LIMIT = 20;
const TAG_LENGTH = 12;

const GOLDEN_REBUILD_PREFIXES = ["infra/images/"] as const;
const GOLDEN_REBUILD_FILES = [
  "pnpm-lock.yaml",
  "package.json",
  "scripts/publish-images.sh",
  "infra/terraform/modules/ecs-dev-desktop/build-codebuild.tf",
] as const;

export interface ImageSourceConfig {
  readonly repo: string;
  readonly branch: string;
  readonly webhookSecret: string;
}

interface SourceRecord {
  readonly id: string;
  readonly schemaVersion: number;
  readonly repo: string;
  readonly branch: string;
  readonly lastObservedSha?: string;
  readonly lastHandledSha?: string;
  readonly latestTriggerId?: string;
  readonly updatedAt: string;
}

interface TriggerRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly repo: string;
  readonly branch: string;
  readonly beforeSha?: string;
  readonly afterSha: string;
  readonly changedPaths: string[];
  readonly decision: "build" | "skip";
  readonly reason: string;
  readonly status: ImageSourceTriggerStatusDto;
  readonly target?: BuildTargetDto;
  readonly tag?: string;
  readonly sourceVersion?: string;
  readonly buildId?: string;
  readonly triggeredBy: string;
  readonly receivedAt: string;
  readonly updatedAt: string;
}

export interface SourceObservation {
  readonly beforeSha?: string;
  readonly afterSha: string;
  readonly changedPaths: readonly string[];
  readonly triggeredBy: "github-webhook";
}

export interface GithubPushPayload {
  readonly ref?: string;
  readonly before?: string;
  readonly after?: string;
  readonly commits?: readonly {
    readonly added?: readonly string[];
    readonly modified?: readonly string[];
    readonly removed?: readonly string[];
  }[];
  readonly repository?: { readonly full_name?: string };
}

export function imageSourceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImageSourceConfig {
  const repo = env.EDD_IMAGE_SOURCE_REPO;
  if (repo === undefined || repo === "") throw new Error("EDD_IMAGE_SOURCE_REPO is required");
  const webhookSecret = env.EDD_IMAGE_SOURCE_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret === "") {
    throw new Error("EDD_IMAGE_SOURCE_WEBHOOK_SECRET is required");
  }
  return {
    repo,
    branch: env.EDD_IMAGE_SOURCE_BRANCH ?? DEFAULT_BRANCH,
    webhookSecret,
  };
}

export function decideImageSourceBuild(paths: readonly string[]): {
  readonly decision: "build" | "skip";
  readonly reason: string;
  readonly target?: BuildTargetDto;
} {
  const rebuild = paths.some(
    (p) =>
      GOLDEN_REBUILD_FILES.includes(p as (typeof GOLDEN_REBUILD_FILES)[number]) ||
      GOLDEN_REBUILD_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
  if (rebuild)
    return { decision: "build", reason: "workspace image inputs changed", target: "golden" };
  return { decision: "skip", reason: "no workspace image inputs changed" };
}

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (signatureHeader?.startsWith("sha256=") !== true) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const received = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

export function observationFromGithubPush(
  payload: GithubPushPayload,
  expectedRepo: string,
  expectedBranch: string,
): SourceObservation | null {
  if (payload.repository?.full_name !== expectedRepo) return null;
  if (payload.ref !== `refs/heads/${expectedBranch}`) return null;
  if (payload.after === undefined || payload.after === "") return null;
  const changedPaths = new Set<string>();
  for (const commit of payload.commits ?? []) {
    for (const p of commit.added ?? []) changedPaths.add(p);
    for (const p of commit.modified ?? []) changedPaths.add(p);
    for (const p of commit.removed ?? []) changedPaths.add(p);
  }
  return {
    ...(payload.before === undefined || payload.before === "" ? {} : { beforeSha: payload.before }),
    afterSha: payload.after,
    changedPaths: [...changedPaths].sort(),
    triggeredBy: "github-webhook",
  };
}

export class ImageSourceService {
  constructor(
    private readonly deps: {
      readonly sources: ImageSourceEntity;
      readonly triggers: ImageSourceTriggerEntity;
      readonly imageOps: () => ImageOps;
      readonly cfg: ImageSourceConfig;
      readonly now: () => Date;
    },
  ) {}

  async state(): Promise<ImageSourceStateDto> {
    const cfg = this.deps.cfg;
    const source = await this.ensureSource(cfg.repo);
    const triggers = await this.recentTriggers();
    return {
      repo: source.repo,
      branch: source.branch,
      ...(source.lastObservedSha === undefined ? {} : { lastObservedSha: source.lastObservedSha }),
      ...(source.lastHandledSha === undefined ? {} : { lastHandledSha: source.lastHandledSha }),
      ...(source.latestTriggerId === undefined ? {} : { latestTriggerId: source.latestTriggerId }),
      updatedAt: source.updatedAt,
      triggers,
    };
  }

  async handleObservation(observation: SourceObservation): Promise<ImageSourceTriggerDto> {
    const cfg = this.deps.cfg;
    const source = await this.ensureSource(cfg.repo);
    if (observation.afterSha === source.lastHandledSha) {
      const now = this.nowIso();
      await this.putSource({ ...source, lastObservedSha: observation.afterSha, updatedAt: now });
      return toTriggerDto(
        triggerRecordFromObservation({
          source,
          observation,
          id: source.latestTriggerId ?? "already-handled",
          decision: "skip",
          reason: "commit already handled",
          status: "skipped",
          now,
        }),
      );
    }

    const decision = decideImageSourceBuild(observation.changedPaths);
    const now = this.nowIso();
    const base = triggerRecordFromObservation({
      source,
      observation,
      id: randomUUID(),
      decision: decision.decision,
      reason: decision.reason,
      status: decision.decision === "skip" ? "skipped" : "received",
      ...(decision.target === undefined ? {} : { target: decision.target }),
      now,
    });
    const started =
      decision.decision === "build" && decision.target !== undefined
        ? await this.startBuild(base, decision.target)
        : base;
    await this.putTrigger(started);
    await this.putSource({
      ...source,
      lastObservedSha: observation.afterSha,
      lastHandledSha: observation.afterSha,
      latestTriggerId: base.id,
      updatedAt: started.updatedAt,
    });
    return toTriggerDto(started);
  }

  private async startBuild(base: TriggerRecord, target: BuildTargetDto): Promise<TriggerRecord> {
    const tag = base.afterSha.slice(0, TAG_LENGTH);
    const buildId = await this.deps.imageOps().startBuild({
      target,
      tag,
      ref: base.branch,
      sourceVersion: base.afterSha,
      triggeredBy: BUILD_TRIGGER,
    });
    return {
      ...base,
      status: "queued",
      target,
      tag,
      sourceVersion: base.afterSha,
      buildId,
      updatedAt: this.nowIso(),
    };
  }

  async reconcileRecentBuilds(): Promise<void> {
    const triggers = await this.recentTriggerRecords();
    const active = triggers.filter((t) => t.buildId !== undefined && isOpenTrigger(t.status));
    if (active.length === 0) return;
    await Promise.all(
      active.map(async (trigger) => {
        const build = await this.deps.imageOps().getBuild(trigger.buildId ?? "");
        if (build === null) return;
        const status = triggerStatusFromBuild(build.status);
        await this.putTrigger({ ...trigger, status, updatedAt: this.nowIso() });
      }),
    );
  }

  private async ensureSource(repo: string): Promise<SourceRecord> {
    const existing = (await this.deps.sources.get({ id: SOURCE_ID }).go()).data;
    if (existing !== null && existing.schemaVersion === SOURCE_SCHEMA_VERSION) return existing;
    const now = this.nowIso();
    const source: SourceRecord = {
      id: SOURCE_ID,
      schemaVersion: SOURCE_SCHEMA_VERSION,
      repo,
      branch: this.deps.cfg.branch,
      updatedAt: now,
    };
    await this.putSource(source);
    return source;
  }

  private async putSource(source: SourceRecord): Promise<void> {
    await this.deps.sources.put(source).go();
  }

  private async putTrigger(trigger: TriggerRecord): Promise<void> {
    await this.deps.triggers.put(trigger).go();
  }

  private async recentTriggers(): Promise<ImageSourceTriggerDto[]> {
    return (await this.recentTriggerRecords()).map(toTriggerDto);
  }

  private async recentTriggerRecords(): Promise<TriggerRecord[]> {
    const res = await this.deps.triggers.query
      .bySource({ sourceId: SOURCE_ID })
      .go({ pages: "all" });
    return res.data
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, RECENT_TRIGGER_LIMIT);
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }
}

function isOpenTrigger(status: ImageSourceTriggerStatusDto): boolean {
  return status === "queued" || status === "building" || status === "received";
}

function triggerStatusFromBuild(status: BuildStatusDto): ImageSourceTriggerStatusDto {
  if (status === "succeeded") return "succeeded";
  if (status === "in_progress") return "building";
  return "failed";
}

function triggerRecordFromObservation(input: {
  readonly source: SourceRecord;
  readonly observation: SourceObservation;
  readonly id: string;
  readonly decision: "build" | "skip";
  readonly reason: string;
  readonly status: ImageSourceTriggerStatusDto;
  readonly target?: BuildTargetDto;
  readonly now: string;
}): TriggerRecord {
  return {
    id: input.id,
    sourceId: SOURCE_ID,
    schemaVersion: SOURCE_SCHEMA_VERSION,
    repo: input.source.repo,
    branch: input.source.branch,
    ...(input.observation.beforeSha === undefined
      ? {}
      : { beforeSha: input.observation.beforeSha }),
    afterSha: input.observation.afterSha,
    changedPaths: [...input.observation.changedPaths],
    decision: input.decision,
    reason: input.reason,
    status: input.status,
    ...(input.target === undefined ? {} : { target: input.target }),
    triggeredBy: input.observation.triggeredBy,
    receivedAt: input.now,
    updatedAt: input.now,
  };
}

function toTriggerDto(trigger: TriggerRecord): ImageSourceTriggerDto {
  return {
    id: trigger.id,
    repo: trigger.repo,
    branch: trigger.branch,
    ...(trigger.beforeSha === undefined ? {} : { beforeSha: trigger.beforeSha }),
    afterSha: trigger.afterSha,
    changedPaths: [...trigger.changedPaths],
    decision: trigger.decision,
    reason: trigger.reason,
    status: trigger.status,
    ...(trigger.target === undefined ? {} : { target: trigger.target }),
    ...(trigger.tag === undefined ? {} : { tag: trigger.tag }),
    ...(trigger.sourceVersion === undefined ? {} : { sourceVersion: trigger.sourceVersion }),
    ...(trigger.buildId === undefined ? {} : { buildId: trigger.buildId }),
    triggeredBy: trigger.triggeredBy,
    receivedAt: trigger.receivedAt,
    updatedAt: trigger.updatedAt,
  };
}

let imageSourceService: ImageSourceService | undefined;

export function getImageSourceService(): ImageSourceService {
  imageSourceService ??= new ImageSourceService({
    sources: makeImageSourceEntity(createDynamoClient(), tableName()),
    triggers: makeImageSourceTriggerEntity(createDynamoClient(), tableName()),
    imageOps: getImageOps,
    cfg: imageSourceConfigFromEnv(),
    now: () => new Date(),
  });
  return imageSourceService;
}
