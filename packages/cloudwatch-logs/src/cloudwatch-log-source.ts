// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  ResourceNotFoundException,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  assertNever,
  isoTimestamp,
  type LogLevel,
  type LogLine,
  type LogSource,
  type LogStream,
  type LogStreamResult,
} from "@edd/core";

export function logGroup(stream: LogStream, appName: string): string {
  switch (stream) {
    case "control-plane":
      return `/${appName}/control-plane`;
    case "reconciler":
      return `/${appName}/reconciler`;
    case "container":
      return `/${appName}/workspaces`;
    default:
      return assertNever(stream);
  }
}

const STREAM_NOTE: Record<LogStream, string> = {
  "control-plane": "CloudWatch Logs — control-plane app stream",
  reconciler: "CloudWatch Logs — reconciler run logs",
  container: "CloudWatch Logs — per-workspace container logs",
};

/**
 * `LogSource` backed by CloudWatch Logs `FilterLogEvents`. Returns all three
 * streams when the log groups exist; returns `available: false` with a note
 * when a group is absent (first deploy, no traffic yet).
 * Differs from `DerivedLogSource` by endpoint configuration only (§6.8).
 */
export class CloudWatchLogSource implements LogSource {
  constructor(
    private readonly client: CloudWatchLogsClient,
    private readonly appName: string,
  ) {}

  static fromEnv(appName: string): CloudWatchLogSource {
    return new CloudWatchLogSource(new CloudWatchLogsClient({}), appName);
  }

  async read(stream: LogStream): Promise<LogStreamResult> {
    const logGroupName = logGroup(stream, this.appName);
    const note = STREAM_NOTE[stream];
    try {
      const out = await this.client.send(new FilterLogEventsCommand({ logGroupName, limit: 200 }));
      const lines = (out.events ?? []).map((e: FilteredLogEvent) => toLogLine(e, stream));
      return { stream, available: true, note, lines };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return { stream, available: false, note: `${note} — log group not found`, lines: [] };
      }
      throw err;
    }
  }
}

export function toLogLine(e: FilteredLogEvent, stream: LogStream): LogLine {
  return {
    at: isoTimestamp(new Date(e.timestamp ?? 0).toISOString()),
    level: parseLevel(e.message ?? ""),
    source: stream,
    message: e.message ?? "",
  };
}

export function parseLevel(msg: string): LogLevel {
  const m = msg.toLowerCase();
  if (m.includes("error") || m.includes(" err ") || m.includes(" err:")) return "error";
  if (m.includes("warn")) return "warn";
  return "info";
}
