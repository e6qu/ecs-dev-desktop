// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  ResourceNotFoundException,
  type FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { describe, expect, it, vi } from "vitest";

import { CloudWatchLogSource, logGroup, parseLevel, toLogLine } from "./cloudwatch-log-source";

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

  it("defaults to epoch when timestamp is absent", () => {
    const line = toLogLine({ message: "warn: something" }, "reconciler");
    expect(line.at).toBe("1970-01-01T00:00:00.000Z");
    expect(line.level).toBe("warn");
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
});
