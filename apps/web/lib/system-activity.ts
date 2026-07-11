// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Control-plane activity stamping — the web-app half of control-plane
 * scale-to-zero. On each real authenticated user request the control plane records
 * "the app was just used" so the reconciler's idle-shutdown sweep knows when it has
 * been quiet long enough to scale to zero.
 *
 * The write must be cheap: a busy control plane at 200+ scale must not write DynamoDB
 * on every request. So it is THROTTLED to at most once per {@link ACTIVITY_MIN_WRITE_INTERVAL_MS}
 * using an in-process last-write timestamp — a busy CP writes ~1/min, and the small
 * loss of precision doesn't matter against a 15-minute idle threshold. It is also
 * best-effort and non-blocking: it never fails a request. But a real error is LOGGED
 * (never silently swallowed — §6.5).
 */
import { isoTimestamp } from "@edd/core";

import { errorField, log } from "./logger";

/**
 * Shortest interval between DynamoDB activity writes (in-process throttle). 60s keeps a
 * busy control plane at ~1 write/min while staying far below the 15-minute idle
 * threshold, so the recorded activity is never stale enough to trigger a false
 * scale-to-zero.
 */
export const ACTIVITY_MIN_WRITE_INTERVAL_MS = 60_000;

/**
 * Pure throttle decision: should this request write an activity record, given the
 * epoch-ms of the last write this process performed (`undefined` when none yet), the
 * current epoch-ms, and the minimum interval? True on the first request and once the
 * interval has elapsed; false otherwise. A non-finite `now` is a defensive false (never
 * a spurious write). Deterministic — the caller passes time in (§6.10).
 */
export function shouldRecordActivity(
  lastWrittenAtMs: number | undefined,
  nowMs: number,
  minIntervalMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (lastWrittenAtMs === undefined) return true;
  return nowMs - lastWrittenAtMs >= minIntervalMs;
}

/** In-process timestamp (epoch ms) of the last activity write this process performed. */
let lastWrittenAtMs: number | undefined;

/**
 * Best-effort, non-blocking, throttled record that the control plane just served a
 * real authenticated request. Returns immediately (no I/O) when the throttle window
 * hasn't elapsed. The throttle timestamp is advanced BEFORE the write so concurrent
 * requests don't stampede DynamoDB and a transient write failure simply retries on the
 * next request past the window. Never throws — a genuine write error is logged, not
 * surfaced to the caller (so it can never fail the user's request).
 */
export async function recordSystemActivity(now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  if (!shouldRecordActivity(lastWrittenAtMs, nowMs, ACTIVITY_MIN_WRITE_INTERVAL_MS)) return;
  // Advance first: gate concurrent callers and avoid hammering on repeated failures.
  lastWrittenAtMs = nowMs;
  try {
    // Lazy import keeps this module (and its importers, e.g. principal.ts) free of the
    // heavy control-plane dependency graph at load time.
    const { getControlPlaneActivity } = await import("./control-plane");
    await getControlPlaneActivity().recordActivity(isoTimestamp(now.toISOString()));
  } catch (err) {
    log.warn("failed to record control-plane activity (non-fatal)", { error: errorField(err) });
  }
}
