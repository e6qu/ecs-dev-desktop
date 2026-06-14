// SPDX-License-Identifier: AGPL-3.0-or-later
import { createLogger, systemClock, type StructuredLogger } from "@edd/core";

/**
 * The control plane's structured (JSON-per-line) logger. One JSON object per
 * line so CloudWatch Logs Insights can query by field (level, service, action,
 * …) instead of regex over free text — replaces the ad-hoc `console.*` lines.
 */
export const log: StructuredLogger = createLogger({
  service: "control-plane",
  clock: systemClock,
  write: (line) => void process.stdout.write(`${line}\n`),
});

/** A thrown value rendered as a log-field string. */
export function errorField(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
