// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IsoTimestamp, TaskId } from "../domain/ids";

import type { AuditEvent } from "./audit";

/**
 * The log streams the admin Logs screen can surface. `control-plane` is derived
 * from the control plane's own state now; `reconciler` and `container` are
 * genuinely unavailable until AWS, where each maps to a **CloudWatch Logs**
 * group (`docs/admin-ui-design.md`).
 */
export type LogStream = "control-plane" | "reconciler" | "container";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  readonly at: IsoTimestamp;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
}

/**
 * The result of reading one stream. `available` is explicit (not a silent empty)
 * so the UI can distinguish "no lines" from "this stream has no source wired in
 * this environment" — the latter carries a `note` saying where it comes from.
 */
export interface LogStreamResult {
  readonly stream: LogStream;
  readonly available: boolean;
  readonly note: string;
  readonly lines: readonly LogLine[];
}

/**
 * Narrows a `read` to a single workspace. Only the `container` stream has a
 * per-workspace dimension (its CloudWatch stream is keyed by the workspace's ECS
 * task); other streams ignore it. The branded `TaskId` (the task ARN) is carried
 * so the adapter — not the caller — knows how to turn it into a log-stream filter.
 */
export interface LogReadFilter {
  readonly taskId?: TaskId;
}

/** Reads a single log stream. Derived/CloudWatch by adapter; same interface. */
export interface LogSource {
  read(stream: LogStream, filter?: LogReadFilter): Promise<LogStreamResult>;
}

/**
 * Pure: project audit events into control-plane log lines. Pre-AWS this *is* the
 * control-plane app stream — every mutation the control plane made, as a line.
 * On AWS the CloudWatch adapter replaces it with the app's emitted logs.
 */
export function auditToLogLines(events: readonly AuditEvent[]): LogLine[] {
  return events.map(
    (e): LogLine => ({
      at: e.at,
      level: "info",
      source: e.target,
      message: `${e.action} (${e.actor}) — ${e.detail}`,
    }),
  );
}
