// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  auditToLogLines,
  type AuditSource,
  type LogReadFilter,
  type LogSource,
  type LogStream,
  type LogStreamResult,
} from "@edd/core";

export interface DerivedLogSourceDeps {
  audit: AuditSource;
}

// Where each stream's lines come from. The control-plane app stream is derived
// from state now; the others have no local source and stream from CloudWatch
// once deployed (an adapter swap — `docs/admin-ui-design.md`).
const STREAM_NOTE: Record<LogStream, string> = {
  "control-plane": "derived from control-plane state — CloudWatch app stream on AWS",
  reconciler: "reconciler run logs stream from CloudWatch on AWS",
  container: "per-workspace container logs stream from CloudWatch on AWS",
};

/**
 * Local `LogSource`. Only the control-plane stream has a real local source (the
 * derived audit, projected to log lines); `reconciler`/`container` are reported
 * **explicitly unavailable** — never a silent empty — because their logs exist
 * only once deployed (CloudWatch on AWS). Same interface as the cloud adapter.
 */
export class DerivedLogSource implements LogSource {
  constructor(private readonly deps: DerivedLogSourceDeps) {}

  // The optional per-workspace filter is honored only by the CloudWatch adapter
  // (the container stream). Locally there is no per-workspace source, so it's
  // accepted for interface parity and ignored.
  async read(stream: LogStream, _filter?: LogReadFilter): Promise<LogStreamResult> {
    const note = STREAM_NOTE[stream];
    if (stream !== "control-plane") {
      return { stream, available: false, note, lines: [] };
    }
    const lines = auditToLogLines(await this.deps.audit.recent());
    return { stream, available: true, note, lines };
  }
}
