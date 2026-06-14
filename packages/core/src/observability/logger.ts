// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from "../clock";

import type { LogLevel } from "./logs";

/**
 * Structured (JSON-per-line) logging for the imperative shell — the control
 * plane and reconciler. Emitting one JSON object per line means CloudWatch Logs
 * Insights can query by field (level, service, workspaceId, …) instead of regex
 * over free text, which the old bare `console.*` lines could not support. The
 * core stays pure: the writer is injected, so this is fully unit-testable and
 * carries no platform (`process`) reference.
 */
export type LogFieldValue = string | number | boolean;

export type LogFields = Record<string, LogFieldValue | undefined>;

export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Pure: render one structured log line. `undefined` fields are omitted. */
export function formatLogLine(
  level: LogLevel,
  service: string,
  message: string,
  at: string,
  fields?: LogFields,
): string {
  const record: Record<string, LogFieldValue> = { level, ts: at, service, msg: message };
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) record[key] = value;
    }
  }
  return JSON.stringify(record);
}

export interface LoggerDeps {
  /** Logical source name (e.g. `reconciler`, `control-plane`). */
  service: string;
  clock: Clock;
  /** Sink for each rendered line (e.g. stdout → CloudWatch). Injected for tests. */
  write: (line: string) => void;
}

/** A `StructuredLogger` that renders each call to one JSON line via `write`. */
export function createLogger(deps: LoggerDeps): StructuredLogger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    deps.write(formatLogLine(level, deps.service, message, deps.clock.now(), fields));
  };
  return {
    info: (message, fields) => {
      emit("info", message, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, fields);
    },
    error: (message, fields) => {
      emit("error", message, fields);
    },
  };
}
