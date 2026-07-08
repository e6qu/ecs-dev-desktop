// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin "Images" console backend: read ECR image metadata (size + per-layer
// breakdown) and, for older CodeBuild-backed runs, inspect build history/logs.
// The post-merge golden publish path is GitHub Actions; the control plane uses
// ECR image presence as the convergence fact. A narrow PORT (ImageOps) with a
// real AWS adapter + an in-memory fake (tests), so routes never touch the SDK
// directly. Coordinates (region, project, registry) come from env — the same code
// hits a sim or real AWS by config alone.
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  StartBuildCommand,
} from "@aws-sdk/client-codebuild";
import { BatchGetImageCommand, DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type {
  BuildLogChunkDto,
  BuildStatusDto,
  BuildTargetDto,
  ImageMetadataDto,
} from "@edd/api-contracts";

/** A started/observed build's live status (the AWS-facing slice; history lives in DDB). */
export interface BuildObservation {
  readonly status: BuildStatusDto;
  readonly phase?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** The CloudWatch log stream name for this build (to follow its logs). */
  readonly logGroup?: string;
  readonly logStream?: string;
}

/** A build in the project's history (newest-first list). */
export interface BuildSummary {
  readonly buildId: string;
  readonly target: BuildTargetDto;
  readonly tag: string;
  readonly status: BuildStatusDto;
  readonly phase?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  /** The git ref the build resolved to (from CodeBuild). */
  readonly ref?: string;
  /** Exact source commit checked out after cloning the ref, when provided. */
  readonly sourceVersion?: string;
  /** The user/system that started it. */
  readonly triggeredBy: string;
}

export interface StartImageBuildInput {
  readonly target: BuildTargetDto;
  readonly tag: string;
  readonly ref: string;
  readonly sourceVersion?: string;
  readonly triggeredBy?: string;
}

/** The narrow port the admin Images routes depend on. */
export interface ImageOps {
  /** Registry metadata (compressed size + per-layer breakdown) for one image tag. */
  getImageMetadata(repo: string, tag: string): Promise<ImageMetadataDto | null>;
  /** Recent tags pushed to a repo, newest first. */
  listImageTags(repo: string, limit: number): Promise<string[]>;
  /** Start a CodeBuild build for explicit operator tooling; not used by source sync. */
  startBuild(input: StartImageBuildInput): Promise<string>;
  /** Current status of a build, or null if unknown. */
  getBuild(buildId: string): Promise<BuildObservation | null>;
  /** The project's most recent builds (history), newest first. */
  listRecentBuilds(limit: number): Promise<BuildSummary[]>;
  /** A slice of a build's log stream from `nextToken` (or the start). */
  getBuildLogs(observation: BuildObservation, nextToken?: string): Promise<BuildLogChunkDto>;
}

/** Map CodeBuild's status string to our contract enum. */
function toBuildStatus(s: string | undefined): BuildStatusDto {
  switch (s) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "FAULT":
      return "faulted";
    case "TIMED_OUT":
      return "timed_out";
    case "STOPPED":
      return "stopped";
    default:
      return "in_progress";
  }
}

interface ManifestLayer {
  readonly digest: string;
  readonly size: number;
}
interface ImageManifest {
  readonly config?: { readonly size?: number };
  readonly layers?: readonly ManifestLayer[];
  readonly manifests?: readonly {
    readonly digest: string;
    readonly platform?: { readonly architecture?: string };
  }[];
}

/** Config the AWS ImageOps adapter reads from the environment. */
interface AwsImageOpsConfig {
  readonly region: string;
  /** The CodeBuild project that builds the platform images. */
  readonly codeBuildProject: string;
  /** CloudWatch log group the CodeBuild project writes to. */
  readonly buildLogGroup: string;
}

interface CodeBuildEnvVar {
  readonly name?: string;
  readonly value?: string;
}

interface CodeBuildBuildSummaryInput {
  readonly id?: string;
  readonly buildStatus?: string;
  readonly currentPhase?: string;
  readonly startTime?: Date;
  readonly endTime?: Date;
  readonly resolvedSourceVersion?: string;
  readonly initiator?: string;
  readonly environment?: { readonly environmentVariables?: readonly CodeBuildEnvVar[] };
}

const UNKNOWN_BUILD_VALUE = "unknown";

function envValue(build: CodeBuildBuildSummaryInput, name: string): string | undefined {
  return build.environment?.environmentVariables?.find((v) => v.name === name)?.value;
}

function toBuildTarget(value: string | undefined): BuildTargetDto {
  if (value === "web" || value === "golden" || value === "all") return value;
  return "all";
}

export function buildSummaryFromCodeBuild(build: CodeBuildBuildSummaryInput): BuildSummary | null {
  if (build.id === undefined) return null;
  const startedAt = build.startTime?.toISOString();
  const endedAt = build.endTime?.toISOString();
  const sourceVersion = envValue(build, "SOURCE_VERSION");
  const sourceRef = envValue(build, "SOURCE_REF");
  const resolvedRef =
    sourceVersion !== undefined && sourceVersion !== ""
      ? sourceVersion
      : (build.resolvedSourceVersion ?? sourceRef);
  return {
    buildId: build.id,
    target: toBuildTarget(envValue(build, "EDD_BUILD_TARGET")),
    tag: envValue(build, "TAG") ?? UNKNOWN_BUILD_VALUE,
    status: toBuildStatus(build.buildStatus),
    ...(build.currentPhase === undefined ? {} : { phase: build.currentPhase }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(build.startTime !== undefined && build.endTime !== undefined
      ? { durationMs: build.endTime.getTime() - build.startTime.getTime() }
      : {}),
    ...(resolvedRef === undefined ? {} : { ref: resolvedRef }),
    ...(sourceVersion === undefined || sourceVersion === "" ? {} : { sourceVersion }),
    triggeredBy: envValue(build, "EDD_TRIGGER") ?? build.initiator ?? UNKNOWN_BUILD_VALUE,
  };
}

class AwsImageOps implements ImageOps {
  private readonly ecr: ECRClient;
  private readonly codebuild: CodeBuildClient;
  private readonly logs: CloudWatchLogsClient;

  constructor(private readonly cfg: AwsImageOpsConfig) {
    this.ecr = new ECRClient({ region: cfg.region });
    this.codebuild = new CodeBuildClient({ region: cfg.region });
    this.logs = new CloudWatchLogsClient({ region: cfg.region });
  }

  async getImageMetadata(repo: string, tag: string): Promise<ImageMetadataDto | null> {
    const described = await this.ecr.send(
      new DescribeImagesCommand({ repositoryName: repo, imageIds: [{ imageTag: tag }] }),
    );
    const detail = described.imageDetails?.[0];
    if (detail?.imageDigest === undefined) return null;

    // Resolve to a concrete image manifest (our tags are single-child manifest lists
    // — CodeBuild builds amd64 only — so follow the list to the child if present).
    const manifest = await this.fetchManifest(repo, { imageTag: tag });
    let layers: ManifestLayer[] = manifest?.layers ? [...manifest.layers] : [];
    let architecture: string | undefined;
    if ((manifest?.manifests?.length ?? 0) > 0) {
      const child = manifest?.manifests?.[0];
      architecture = child?.platform?.architecture;
      if (child?.digest !== undefined) {
        const childManifest = await this.fetchManifest(repo, { imageDigest: child.digest });
        layers = childManifest?.layers ? [...childManifest.layers] : [];
      }
    }
    const compressedBytes = detail.imageSizeInBytes ?? layers.reduce((n, l) => n + l.size, 0);
    return {
      repo,
      tag,
      digest: detail.imageDigest,
      compressedBytes,
      layerCount: layers.length,
      layers: layers.map((l) => ({ digest: l.digest, sizeBytes: l.size })),
      ...(architecture === undefined ? {} : { architecture }),
      ...(detail.imagePushedAt === undefined
        ? {}
        : { pushedAt: detail.imagePushedAt.toISOString() }),
    };
  }

  private async fetchManifest(
    repo: string,
    id: { imageTag: string } | { imageDigest: string },
  ): Promise<ImageManifest | null> {
    const res = await this.ecr.send(
      new BatchGetImageCommand({
        repositoryName: repo,
        imageIds: [id],
        acceptedMediaTypes: [
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.oci.image.index.v1+json",
        ],
      }),
    );
    const raw = res.images?.[0]?.imageManifest;
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as ImageManifest;
    } catch {
      return null;
    }
  }

  async listImageTags(repo: string, limit: number): Promise<string[]> {
    const res = await this.ecr.send(new DescribeImagesCommand({ repositoryName: repo }));
    return (
      (res.imageDetails ?? [])
        .filter((d) => (d.imageTags?.length ?? 0) > 0)
        .sort((a, b) => (b.imagePushedAt?.getTime() ?? 0) - (a.imagePushedAt?.getTime() ?? 0))
        .flatMap((d) => d.imageTags ?? [])
        // Skip the per-arch suffixed tags; show the manifest tags operators recognize.
        .filter((t) => !/-amd64$|-arm64$/.test(t))
        .slice(0, limit)
    );
  }

  async startBuild(input: StartImageBuildInput): Promise<string> {
    const res = await this.codebuild.send(
      new StartBuildCommand({
        projectName: this.cfg.codeBuildProject,
        environmentVariablesOverride: [
          { name: "EDD_BUILD_TARGET", value: input.target, type: "PLAINTEXT" },
          { name: "TAG", value: input.tag, type: "PLAINTEXT" },
          { name: "SOURCE_REF", value: input.ref, type: "PLAINTEXT" },
          ...(input.sourceVersion === undefined
            ? []
            : [{ name: "SOURCE_VERSION", value: input.sourceVersion, type: "PLAINTEXT" as const }]),
          { name: "EDD_TRIGGER", value: input.triggeredBy ?? "admin", type: "PLAINTEXT" },
        ],
      }),
    );
    const id = res.build?.id;
    if (id === undefined) throw new Error("CodeBuild StartBuild returned no build id");
    return id;
  }

  async getBuild(buildId: string): Promise<BuildObservation | null> {
    const res = await this.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const b = res.builds?.[0];
    if (b === undefined) return null;
    return {
      status: toBuildStatus(b.buildStatus),
      ...(b.currentPhase === undefined ? {} : { phase: b.currentPhase }),
      ...(b.startTime === undefined ? {} : { startedAt: b.startTime.toISOString() }),
      ...(b.endTime === undefined ? {} : { endedAt: b.endTime.toISOString() }),
      ...(b.logs?.groupName === undefined ? {} : { logGroup: b.logs.groupName }),
      ...(b.logs?.streamName === undefined ? {} : { logStream: b.logs.streamName }),
    };
  }

  async listRecentBuilds(limit: number): Promise<BuildSummary[]> {
    const listed = await this.codebuild.send(
      new ListBuildsForProjectCommand({ projectName: this.cfg.codeBuildProject }),
    );
    const ids = (listed.ids ?? []).slice(0, limit);
    if (ids.length === 0) return [];
    const res = await this.codebuild.send(new BatchGetBuildsCommand({ ids }));
    // CodeBuild returns builds unordered; preserve the newest-first id order.
    const byId = new Map((res.builds ?? []).map((b) => [b.id, b]));
    return ids.flatMap((id) => {
      const b = byId.get(id);
      const summary = b === undefined ? null : buildSummaryFromCodeBuild(b);
      return summary === null ? [] : [summary];
    });
  }

  async getBuildLogs(observation: BuildObservation, nextToken?: string): Promise<BuildLogChunkDto> {
    if (observation.logGroup === undefined || observation.logStream === undefined) {
      return { lines: [] };
    }
    const res = await this.logs.send(
      new GetLogEventsCommand({
        logGroupName: observation.logGroup,
        logStreamName: observation.logStream,
        startFromHead: true,
        ...(nextToken === undefined ? {} : { nextToken }),
      }),
    );
    return {
      lines: (res.events ?? []).map((e) => ({
        at: new Date(e.timestamp ?? 0).toISOString(),
        message: e.message ?? "",
      })),
      ...(res.nextForwardToken === undefined ? {} : { nextToken: res.nextForwardToken }),
    };
  }
}

/** The platform's ECR repositories, given the golden variants deployed. Repo names
 * mirror the Terraform module: `<prefix>/control-plane`, `<prefix>/ssh-gateway`,
 * and `<prefix>/golden/<variant>` (the prefix is stripped — ECR repo names don't
 * include the registry host). */
export function imageRepos(prefix: string, goldenVariants: readonly string[]): string[] {
  return [
    `${prefix}/control-plane`,
    `${prefix}/ssh-gateway`,
    ...goldenVariants.map((v) => `${prefix}/golden/${v}`),
  ];
}

/** Build the AWS ImageOps from the control-plane's environment. Throws loudly if a
 * required coordinate is missing rather than silently degrading the admin console. */
export function getImageOps(): ImageOps {
  const region = process.env.AWS_REGION;
  const prefix = process.env.EDD_APP_NAME;
  if (region === undefined || region === "")
    throw new Error("AWS_REGION is required for the image console");
  if (prefix === undefined || prefix === "")
    throw new Error("EDD_APP_NAME is required for the image console");
  const project = `${prefix}-build-images`;
  return new AwsImageOps({
    region,
    codeBuildProject: project,
    buildLogGroup: `/aws/codebuild/${project}`,
  });
}
