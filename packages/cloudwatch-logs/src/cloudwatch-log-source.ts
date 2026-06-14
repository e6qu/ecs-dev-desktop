// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  ResourceNotFoundException,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { DEFAULT_WORKSPACE_CONTAINER, DEFAULT_WORKSPACE_LOG_STREAM_PREFIX } from "@edd/config";
import {
  assertNever,
  isoTimestamp,
  type LogLevel,
  type LogLine,
  type LogReadFilter,
  type LogSource,
  type LogStream,
  type LogStreamResult,
} from "@edd/core";

/**
 * The CloudWatch log-stream name prefix for one workspace's ECS task. The awslogs
 * driver names each task's stream `<prefix>/<container>/<taskId>`, where taskId is
 * the last segment of the task ARN — so this narrows the shared workspaces log
 * group to a single workspace.
 */
export function workspaceStreamPrefix(taskArn: string): string {
  const taskId = taskArn.split("/").pop() ?? taskArn;
  return `${DEFAULT_WORKSPACE_LOG_STREAM_PREFIX}/${DEFAULT_WORKSPACE_CONTAINER}/${taskId}`;
}

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

  async read(stream: LogStream, filter?: LogReadFilter): Promise<LogStreamResult> {
    const logGroupName = logGroup(stream, this.appName);
    const note = STREAM_NOTE[stream];
    // Only the container stream is per-workspace; narrow it to the workspace's
    // task log stream when a taskId filter is supplied.
    const logStreamNamePrefix =
      stream === "container" && filter?.taskId !== undefined
        ? workspaceStreamPrefix(filter.taskId)
        : undefined;
    try {
      const out = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName,
          limit: 200,
          ...(logStreamNamePrefix === undefined ? {} : { logStreamNamePrefix }),
        }),
      );
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
