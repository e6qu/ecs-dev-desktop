// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  ResourceNotFoundException,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  AWS_SDK_MAX_ATTEMPTS,
  AWS_SDK_RETRY_MODE,
  DEFAULT_WORKSPACE_CONTAINER,
  DEFAULT_WORKSPACE_LOG_STREAM_PREFIX,
} from "@edd/config";
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

/** Total log lines a single `read()` accumulates across pages. `FilterLogEvents`
 * caps one page at 10 000 events, but with a stream-name prefix an early page can
 * come back empty (or short) while more match later — so the loop must follow
 * `nextToken` until this budget is met, not stop at the first page. */
const LOG_LINE_BUDGET = 200;

/** Max events requested per `FilterLogEvents` page (the API's hard cap is 10 000;
 * we never need more than the remaining budget). */
const FILTER_LOG_EVENTS_PAGE_MAX = 200;

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
    return new CloudWatchLogSource(
      new CloudWatchLogsClient({
        maxAttempts: AWS_SDK_MAX_ATTEMPTS,
        retryMode: AWS_SDK_RETRY_MODE,
      }),
      appName,
    );
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
      // Follow `nextToken` accumulating events until the line budget is met (or the
      // group is exhausted). A single page silently truncated the admin log view —
      // and with a stream prefix an early page can be empty while more events match
      // later (the same class as the resolved CloudTrail/DynamoDB pagination bugs).
      const lines: LogLine[] = [];
      let nextToken: string | undefined;
      do {
        const out = await this.client.send(
          new FilterLogEventsCommand({
            logGroupName,
            limit: Math.min(LOG_LINE_BUDGET - lines.length, FILTER_LOG_EVENTS_PAGE_MAX),
            ...(logStreamNamePrefix === undefined ? {} : { logStreamNamePrefix }),
            ...(nextToken === undefined ? {} : { nextToken }),
          }),
        );
        for (const e of out.events ?? []) {
          lines.push(toLogLine(e, stream));
          if (lines.length >= LOG_LINE_BUDGET) return { stream, available: true, note, lines };
        }
        nextToken = out.nextToken;
      } while (nextToken !== undefined && lines.length < LOG_LINE_BUDGET);
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
  // Fail loud on a missing timestamp rather than coercing it to the Unix epoch
  // (1970) — a `?? 0` fallback would silently mis-date the line (§6.5). CloudWatch
  // always sets it; an absent one is a contract violation worth surfacing. An empty
  // `message` is legitimate (a blank log line), so it keeps its `?? ""`.
  if (e.timestamp === undefined) {
    throw new Error("CloudWatch FilteredLogEvent missing required `timestamp`");
  }
  return {
    at: isoTimestamp(new Date(e.timestamp).toISOString()),
    level: parseLevel(e.message ?? ""),
    source: stream,
    message: e.message ?? "",
  };
}

const LOG_LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error"]);

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.has(value);
}

/** The explicit `level` of a structured log line (`formatLogLine` JSON), or
 * `undefined` for a non-JSON / level-less line (raw container stdout). */
function structuredLevel(msg: string): LogLevel | undefined {
  const trimmed = msg.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined; // not JSON — a raw stdout line; fall back to the heuristic
  }
  if (typeof parsed !== "object" || parsed === null || !("level" in parsed)) return undefined;
  return isLogLevel(parsed.level) ? parsed.level : undefined;
}

export function parseLevel(msg: string): LogLevel {
  // Prefer the structured `level` our loggers emit; only guess from the text for
  // unstructured lines (e.g. raw idle-agent / workspace-process stdout).
  const structured = structuredLevel(msg);
  if (structured !== undefined) return structured;
  const m = msg.toLowerCase();
  if (m.includes("error") || m.includes(" err ") || m.includes(" err:")) return "error";
  if (m.includes("warn")) return "warn";
  return "info";
}
