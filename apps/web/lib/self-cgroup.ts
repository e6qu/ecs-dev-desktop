// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from "node:fs/promises";

/**
 * This container's own cgroup v2 memory accounting, read from inside itself.
 *
 * Why a container reports this about itself rather than a host agent scraping
 * it: exceeding `memory.max` under cgroup v2 does not require an OOM kill. If
 * reclaim can free anything, the kernel stalls the cgroup and throttles its
 * socket buffers instead. Nothing restarts, nothing exits non-zero, and every
 * health check stays green while allocations quietly fail.
 *
 * That is not hypothetical. On this deployment's host two containers were in
 * exactly this state, one of them for five days at ~18,000 socket throttles a
 * second, and no health endpoint, restart count or exit code showed it. The
 * counters below are the only place it appears -- and a container can read its
 * own, so this needs nothing installed on the host.
 *
 * Every field is optional. A value that cannot be read is absent, and the
 * observation publishes it as `unavailable` rather than as 0 -- 0 is a real and
 * healthy reading here, so substituting it would report a clean bill of health
 * for a counter nobody could read.
 */

const CGROUP_ROOT = "/sys/fs/cgroup";

export interface SelfMemory {
  readonly memoryCurrentBytes?: number;
  readonly memoryMaxBytes?: number;
  readonly ceilingHits?: number;
  readonly socketThrottles?: number;
}

/**
 * Read a cgroup file, or undefined when this platform has no cgroup v2.
 *
 * ENOENT only. A blanket catch here would swallow EACCES, EIO and every other
 * real failure into the same "not measurable" answer as a developer's macOS,
 * which is exactly how a broken reader would go unnoticed forever -- the metric
 * would read `unavailable` and nobody would ever learn why. Anything that is
 * not "the file does not exist" is a genuine fault and propagates.
 */
async function readCgroupFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A single integer file, or undefined when it is absent or unparseable. */
async function readCount(path: string): Promise<number | undefined> {
  const raw = await readCgroupFile(path);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // `memory.max` reads "max" when the cgroup is unlimited. That is a real
  // answer -- no ceiling -- but it is not a number, so it has no metric value.
  if (trimmed === "max") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** One `key value` line out of memory.events. */
async function readEvent(key: string): Promise<number | undefined> {
  const raw = await readCgroupFile(`${CGROUP_ROOT}/memory.events`);
  if (raw === undefined) return undefined;
  for (const line of raw.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    }
  }
  return undefined;
}

/**
 * Read this container's memory pressure. Absent everywhere cgroup v2 is not
 * mounted (a developer's macOS, a v1 host), which is why every field is
 * optional rather than defaulted.
 */
export async function readSelfMemory(): Promise<SelfMemory> {
  const [memoryCurrentBytes, memoryMaxBytes, ceilingHits, socketThrottles] = await Promise.all([
    readCount(`${CGROUP_ROOT}/memory.current`),
    readCount(`${CGROUP_ROOT}/memory.max`),
    readEvent("max"),
    readEvent("sock_throttled"),
  ]);
  return { memoryCurrentBytes, memoryMaxBytes, ceilingHits, socketThrottles };
}
