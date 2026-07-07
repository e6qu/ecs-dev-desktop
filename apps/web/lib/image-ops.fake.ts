// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BuildLogChunkDto, ImageMetadataDto } from "@edd/api-contracts";

import type { BuildObservation, BuildSummary, ImageOps, StartImageBuildInput } from "./image-ops";

/** In-memory ImageOps for tests: canned metadata + a recorded build queue. */
export class FakeImageOps implements ImageOps {
  readonly started: StartImageBuildInput[] = [];
  metadata: Record<string, ImageMetadataDto> = {};
  builds: Record<string, BuildObservation> = {};
  recent: BuildSummary[] = [];
  logs: BuildLogChunkDto = { lines: [] };

  getImageMetadata(repo: string, tag: string): Promise<ImageMetadataDto | null> {
    return Promise.resolve(this.metadata[`${repo}:${tag}`] ?? null);
  }
  listImageTags(_repo: string, _limit: number): Promise<string[]> {
    return Promise.resolve(Object.keys(this.metadata).map((k) => k.split(":")[1] ?? ""));
  }
  startBuild(input: StartImageBuildInput): Promise<string> {
    this.started.push(input);
    const id = `build-${String(this.started.length)}`;
    this.builds[id] = { status: "in_progress" };
    return Promise.resolve(id);
  }
  getBuild(buildId: string): Promise<BuildObservation | null> {
    return Promise.resolve(this.builds[buildId] ?? null);
  }
  listRecentBuilds(limit: number): Promise<BuildSummary[]> {
    return Promise.resolve(this.recent.slice(0, limit));
  }
  getBuildLogs(_o: BuildObservation, _nextToken?: string): Promise<BuildLogChunkDto> {
    return Promise.resolve(this.logs);
  }
}
