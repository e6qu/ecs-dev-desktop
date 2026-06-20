// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  ResourceNotFoundException,
  type FilterLogEventsCommand,
  type FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { taskId } from "@edd/core";
import { describe, expect, it, vi } from "vitest";

import {
  CloudWatchLogSource,
  logGroup,
  parseLevel,
  toLogLine,
  workspaceStreamPrefix,
} from "./cloudwatch-log-source";

// ── logGroup (pure) ──────────────────────────────────────────────────────────

describe("logGroup", () => {
  it("maps control-plane stream", () => {
    expect(logGroup("control-plane", "myapp")).toBe("/myapp/control-plane");
  });
  it("maps reconciler stream", () => {
    expect(logGroup("reconciler", "myapp")).toBe("/myapp/reconciler");
  });
  it("maps container stream", () => {
    expect(logGroup("container", "myapp")).toBe("/myapp/workspaces");
  });
});

// ── parseLevel (pure) ────────────────────────────────────────────────────────

describe("parseLevel", () => {
  it("returns info by default", () => {
    expect(parseLevel("workspace ws-abc created")).toBe("info");
  });
  it("returns warn on warn keyword", () => {
    expect(parseLevel("warn: heartbeat timeout")).toBe("warn");
  });
  it("returns error on error keyword", () => {
    expect(parseLevel("error: failed to stop task")).toBe("error");
  });
  it("returns error on err: prefix", () => {
    expect(parseLevel("2026-06-06 err: connection refused")).toBe("error");
  });
  it("is case-insensitive", () => {
    expect(parseLevel("WARNING: slow response")).toBe("warn");
    expect(parseLevel("ERROR stopping task")).toBe("error");
  });

  // Structured lines from the control plane / reconciler carry an explicit `level`
  // (see `formatLogLine`); the read side must honour it, not re-guess from the text.
  it("reads the structured `level` field when present", () => {
    expect(
      parseLevel(
        '{"level":"warn","ts":"2026-06-17T00:00:00.000Z","service":"reconciler","msg":"slow"}',
      ),
    ).toBe("warn");
    expect(parseLevel('{"level":"error","service":"control-plane","msg":"boom"}')).toBe("error");
  });
  it("trusts the structured level even when the message text would mislead the heuristic", () => {
    // msg contains "error", but the record's level is info → must stay info.
    expect(
      parseLevel('{"level":"info","service":"control-plane","msg":"cleared error cache"}'),
    ).toBe("info");
  });
  it("falls back to the heuristic for non-JSON or level-less lines", () => {
    expect(parseLevel('{"service":"x","msg":"error happened"}')).toBe("error"); // no level field
    expect(parseLevel('{"level":"verbose","msg":"hi"}')).toBe("info"); // not a known level
    expect(parseLevel("plain error text")).toBe("error");
  });
});

// ── toLogLine (pure) ─────────────────────────────────────────────────────────

describe("toLogLine", () => {
  it("maps a FilteredLogEvent to a LogLine", () => {
    const line = toLogLine(
      { timestamp: new Date("2026-06-06T10:00:00.000Z").getTime(), message: "info: ok" },
      "control-plane",
    );
    expect(line).toStrictEqual({
      at: "2026-06-06T10:00:00.000Z",
      level: "info",
      source: "control-plane",
      message: "info: ok",
    });
  });

  it("throws on a missing timestamp rather than mis-dating the line to the epoch", () => {
    expect(() => toLogLine({ message: "warn: something" }, "reconciler")).toThrow(/timestamp/);
  });

  it("defaults to empty string when message is absent", () => {
    const line = toLogLine({ timestamp: 0 }, "container");
    expect(line.message).toBe("");
  });
});

// ── CloudWatchLogSource (mock client) ────────────────────────────────────────

describe("CloudWatchLogSource", () => {
  function makeSource(
    response: FilterLogEventsCommandOutput | Error,
    appName = "edd-test",
  ): CloudWatchLogSource {
    const mockSend = vi
      .fn()
      .mockImplementation(() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
      );
    return new CloudWatchLogSource({ send: mockSend } as unknown as CloudWatchLogsClient, appName);
  }

  it("returns available:true with mapped lines for a populated stream", async () => {
    const result = await makeSource({
      events: [{ timestamp: Date.now(), message: "info: started" }],
      $metadata: {},
    }).read("control-plane");
    expect(result.available).toBe(true);
    expect(result.stream).toBe("control-plane");
    expect(result.lines).toHaveLength(1);
  });

  it("returns available:true with empty lines when the group exists but has no events", async () => {
    const result = await makeSource({ events: [], $metadata: {} }).read("reconciler");
    expect(result.available).toBe(true);
    expect(result.lines).toHaveLength(0);
  });

  it("returns available:false when the log group does not exist", async () => {
    const err = new ResourceNotFoundException({ message: "group not found", $metadata: {} });
    const result = await makeSource(err).read("container");
    expect(result.available).toBe(false);
    expect(result.lines).toHaveLength(0);
    expect(result.note).toMatch(/not found/);
  });

  it("rethrows unexpected errors", async () => {
    const src = makeSource(new Error("network failure"));
    await expect(src.read("control-plane")).rejects.toThrow("network failure");
  });

  it("narrows the container stream to a workspace's task when a taskId filter is given", async () => {
    const mockSend = vi.fn().mockResolvedValue({ events: [], $metadata: {} });
    const src = new CloudWatchLogSource(
      { send: mockSend } as unknown as CloudWatchLogsClient,
      "edd-test",
    );

    await src.read("container", { taskId: taskId("arn:aws:ecs:us-east-1:1:task/edd/uuid-1") });
    const containerCall = mockSend.mock.calls[0] as [FilterLogEventsCommand];
    expect(containerCall[0].input).toMatchObject({
      logStreamNamePrefix: "workspace/workspace/uuid-1",
    });

    // The filter is ignored for non-container streams (no per-workspace dimension).
    mockSend.mockClear();
    await src.read("control-plane", { taskId: taskId("arn:aws:ecs:us-east-1:1:task/edd/uuid-1") });
    const cpCall = mockSend.mock.calls[0] as [FilterLogEventsCommand];
    expect(cpCall[0].input.logStreamNamePrefix).toBeUndefined();
  });
});

describe("workspaceStreamPrefix", () => {
  it("builds <prefix>/<container>/<taskId> from a task ARN", () => {
    expect(workspaceStreamPrefix("arn:aws:ecs:us-east-1:123:task/edd/abc123")).toBe(
      "workspace/workspace/abc123",
    );
  });

  it("falls back to the raw value when there is no slash", () => {
    expect(workspaceStreamPrefix("plainid")).toBe("workspace/workspace/plainid");
  });
});
