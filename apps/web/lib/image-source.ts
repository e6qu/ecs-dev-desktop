// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  BuildStatusDto,
  BuildTargetDto,
  ImageSourceStateDto,
  ImageSourceTriggerDto,
  ImageSourceTriggerStatusDto,
} from "@edd/api-contracts";
import { domainErrorMessage } from "@edd/core";
import {
  createDynamoClient,
  makeImageSourceEntity,
  makeImageSourceTriggerEntity,
  type ImageSourceEntity,
  type ImageSourceTriggerEntity,
} from "@edd/db";

import { GITHUB_API_URL_ENV } from "./constants";
import { getCatalog, tableName } from "./control-plane";
import { getImageOps, type ImageOps } from "./image-ops";

const SOURCE_SCHEMA_VERSION = 2;
const SOURCE_ID = "github-main";
const RECENT_TRIGGER_LIMIT = 20;
const TAG_LENGTH = 12;
const CI_PUBLISHED_GOLDEN_IMAGE_REASON = "main push publishes golden images";
const CATALOG_ROLLOUT_FAILED_REASON_PREFIX = "catalog rollout failed:";
const SUPERSEDED_GOLDEN_BUILD_REASON = "superseded by newer successful golden build";
const WAITING_FOR_GITHUB_ACTIONS_REASON =
  "waiting for golden image tag from GitHub Actions workflow";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const GITHUB_DELIVERY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ImageSourceConfig {
  readonly repo: string;
  readonly branch: string;
  readonly webhookSecret: string;
  readonly appName: string;
  readonly goldenVariants: readonly string[];
  readonly githubApiUrl: string;
}

type EnvReader = Readonly<Record<string, string | undefined>>;

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
  readonly triggeredBy: "github-webhook" | "github-poll";
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

export interface GithubCommitPayload {
  readonly sha?: string;
  readonly parents?: readonly { readonly sha?: string }[];
  readonly files?: readonly { readonly filename?: string }[];
}

export interface GithubWebhookRejection {
  readonly status: 400 | 401 | 413;
  readonly error: string;
}

export function imageSourceConfigFromEnv(env: EnvReader = process.env): ImageSourceConfig {
  const repo = env.EDD_IMAGE_SOURCE_REPO;
  if (repo === undefined || repo === "") throw new Error("EDD_IMAGE_SOURCE_REPO is required");
  const webhookSecret = env.EDD_IMAGE_SOURCE_WEBHOOK_SECRET;
  if (webhookSecret === undefined || webhookSecret === "") {
    throw new Error("EDD_IMAGE_SOURCE_WEBHOOK_SECRET is required");
  }
  const appName = env.EDD_APP_NAME;
  if (appName === undefined || appName === "") throw new Error("EDD_APP_NAME is required");
  const golden = env.EDD_GOLDEN;
  if (golden === undefined || golden.trim() === "") throw new Error("EDD_GOLDEN is required");
  const branch = env.EDD_IMAGE_SOURCE_BRANCH;
  if (branch === undefined || branch === "") throw new Error("EDD_IMAGE_SOURCE_BRANCH is required");
  return {
    repo,
    branch,
    webhookSecret,
    appName,
    goldenVariants: golden.split(/\s+/).filter((v) => v.length > 0),
    githubApiUrl: (env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, ""),
  };
}

export function validateGithubWebhookHeaders(headers: Headers): GithubWebhookRejection | null {
  const event = headers.get("x-github-event");
  if (event !== "push") return { status: 400, error: "unsupported event" };
  const delivery = headers.get("x-github-delivery");
  if (delivery === null || !GITHUB_DELIVERY_ID_RE.test(delivery)) {
    return { status: 400, error: "invalid delivery id" };
  }
  const contentType = headers.get("content-type");
  if (contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return { status: 400, error: "content-type must be application/json" };
  }
  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { status: 400, error: "invalid content-length" };
    }
    if (parsed > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      return { status: 413, error: "payload too large" };
    }
  }
  return null;
}

export function validateGithubWebhookBody(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): GithubWebhookRejection | null {
  if (Buffer.byteLength(rawBody, "utf8") > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
    return { status: 413, error: "payload too large" };
  }
  if (!verifyGithubSignature(rawBody, signatureHeader, secret)) {
    return { status: 401, error: "invalid signature" };
  }
  return null;
}

export function decideImageSourceBuild(paths: readonly string[]): {
  readonly decision: "build" | "skip";
  readonly reason: string;
  readonly target?: BuildTargetDto;
} {
  void paths;
  return { decision: "build", reason: CI_PUBLISHED_GOLDEN_IMAGE_REASON, target: "golden" };
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

export function observationFromGithubCommit(
  payload: GithubCommitPayload,
): SourceObservation | null {
  if (payload.sha === undefined || payload.sha === "") return null;
  return {
    ...(payload.parents?.[0]?.sha === undefined ? {} : { beforeSha: payload.parents[0].sha }),
    afterSha: payload.sha,
    changedPaths: (payload.files ?? []).flatMap((file) =>
      file.filename === undefined || file.filename === "" ? [] : [file.filename],
    ),
    triggeredBy: "github-poll",
  };
}

export class ImageSourceService {
  constructor(
    private readonly deps: {
      readonly sources: ImageSourceEntity;
      readonly triggers: ImageSourceTriggerEntity;
      readonly imageOps: () => ImageOps;
      readonly rollCatalogImageTag: (repo: string, tag: string) => Promise<void>;
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
        ? this.queueCiPublishedImage(base, decision.target)
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

  private queueCiPublishedImage(base: TriggerRecord, target: BuildTargetDto): TriggerRecord {
    const tag = base.afterSha.slice(0, TAG_LENGTH);
    return {
      ...base,
      status: "queued",
      target,
      tag,
      sourceVersion: base.afterSha,
      updatedAt: this.nowIso(),
    };
  }

  async reconcileRecentBuilds(): Promise<void> {
    const triggers = await this.recentTriggerRecords();
    const active = triggers.filter(shouldReconcileBuildTrigger);
    if (active.length === 0) return;
    const observed = (
      await Promise.all(
        active.map(async (trigger) => {
          const status = await this.observeTriggerStatus(trigger);
          if (status === null) return;
          return { trigger, status };
        }),
      )
    ).filter((v) => v !== undefined);
    const latestGolden = latestGoldenTrigger(observed);
    for (const observation of observed) {
      const { trigger, status } = observation;
      if (status === "succeeded" && isGoldenTrigger(trigger)) {
        if (latestGolden !== undefined && trigger.id !== latestGolden.id) {
          await this.putTrigger({
            ...trigger,
            status: "succeeded",
            reason: SUPERSEDED_GOLDEN_BUILD_REASON,
            updatedAt: this.nowIso(),
          });
          continue;
        }
        try {
          await this.rollGoldenCatalog(trigger.tag);
        } catch (e) {
          const reason = e instanceof Error ? e.message : "catalog rollout failed";
          await this.putTrigger({
            ...trigger,
            status: "failed",
            reason: `${CATALOG_ROLLOUT_FAILED_REASON_PREFIX} ${reason}`,
            updatedAt: this.nowIso(),
          });
          continue;
        }
      }
      await this.putTrigger({
        ...trigger,
        status,
        reason: successReason(trigger, status),
        updatedAt: this.nowIso(),
      });
    }
  }

  async observeLatestGithubCommit(
    fetchImpl: typeof fetch = fetch,
  ): Promise<ImageSourceTriggerDto | null> {
    const cfg = this.deps.cfg;
    const source = await this.ensureSource(cfg.repo);
    const url = `${cfg.githubApiUrl}/repos/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`;
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "edd-image-source",
      },
    });
    if (!res.ok) throw new Error(`GitHub commit poll failed: ${String(res.status)}`);
    const raw = (await res.json()) as GithubCommitPayload;
    const observation = observationFromGithubCommit(raw);
    if (observation === null) throw new Error("GitHub commit poll returned no commit sha");
    if (observation.afterSha === source.lastHandledSha) return null;
    return this.handleObservation(observation);
  }

  private async rollGoldenCatalog(tag: string): Promise<void> {
    await Promise.all(
      this.deps.cfg.goldenVariants.map(async (variant) => {
        await this.deps.rollCatalogImageTag(`${this.deps.cfg.appName}/golden/${variant}`, tag);
      }),
    );
  }

  private async observeTriggerStatus(
    trigger: TriggerRecord,
  ): Promise<ImageSourceTriggerStatusDto | null> {
    if (trigger.buildId !== undefined) {
      const build = await this.deps.imageOps().getBuild(trigger.buildId);
      return build === null ? null : triggerStatusFromBuild(build.status);
    }
    if (isGoldenTrigger(trigger)) {
      return (await this.allGoldenImagesPublished(trigger.tag)) ? "succeeded" : "building";
    }
    return null;
  }

  private async allGoldenImagesPublished(tag: string): Promise<boolean> {
    const results = await Promise.all(
      this.deps.cfg.goldenVariants.map(async (variant) => {
        const repo = `${this.deps.cfg.appName}/golden/${variant}`;
        return (await this.deps.imageOps().getImageMetadata(repo, tag)) !== null;
      }),
    );
    return results.every((published) => published);
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

function shouldReconcileBuildTrigger(trigger: TriggerRecord): boolean {
  return (
    trigger.target === "golden" &&
    trigger.tag !== undefined &&
    (isOpenTrigger(trigger.status) ||
      (trigger.status === "failed" &&
        trigger.reason.startsWith(CATALOG_ROLLOUT_FAILED_REASON_PREFIX)))
  );
}

function isGoldenTrigger(
  trigger: TriggerRecord,
): trigger is TriggerRecord & { readonly tag: string } {
  return trigger.target === "golden" && trigger.tag !== undefined;
}

function latestGoldenTrigger(
  observations: readonly {
    readonly trigger: TriggerRecord;
    readonly status: ImageSourceTriggerStatusDto;
  }[],
): (TriggerRecord & { readonly tag: string }) | undefined {
  const candidates = observations
    .map((observation) => observation.trigger)
    .filter(isGoldenTrigger)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return candidates[0];
}

function successReason(trigger: TriggerRecord, status: ImageSourceTriggerStatusDto): string {
  if (status === "building" && isGoldenTrigger(trigger) && trigger.buildId === undefined) {
    return WAITING_FOR_GITHUB_ACTIONS_REASON;
  }
  if (status !== "succeeded") return trigger.reason;
  if (trigger.reason.startsWith(CATALOG_ROLLOUT_FAILED_REASON_PREFIX)) {
    return CI_PUBLISHED_GOLDEN_IMAGE_REASON;
  }
  if (trigger.reason === WAITING_FOR_GITHUB_ACTIONS_REASON) {
    return CI_PUBLISHED_GOLDEN_IMAGE_REASON;
  }
  return trigger.reason;
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
    rollCatalogImageTag: async (repo, tag) => {
      const result = await getCatalog().rollImageTag({ repo, tag });
      if (!result.ok) throw new Error(domainErrorMessage(result.error));
    },
    cfg: imageSourceConfigFromEnv(),
    now: () => new Date(),
  });
  return imageSourceService;
}
