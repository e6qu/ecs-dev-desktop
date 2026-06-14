// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock";

import { createLogger, formatLogLine } from "./logger";

const AT = "2026-06-01T00:00:00.000Z";

describe("formatLogLine", () => {
  it("renders a JSON line with level, ts, service, msg, and fields", () => {
    const line = formatLogLine("warn", "reconciler", "swept", AT, { stopped: 3, dryRun: false });
    expect(line).toBe(
      `{"level":"warn","ts":"${AT}","service":"reconciler","msg":"swept","stopped":3,"dryRun":false}`,
    );
  });

  it("omits undefined fields", () => {
    const line = formatLogLine("info", "cp", "hi", AT, { a: 1, b: undefined });
    expect(line).toBe(`{"level":"info","ts":"${AT}","service":"cp","msg":"hi","a":1}`);
  });
});

describe("createLogger", () => {
  it("writes one line per call at the right level", () => {
    const lines: string[] = [];
    const log = createLogger({
      service: "reconciler",
      clock: fixedClock(AT),
      write: (l) => lines.push(l),
    });

    log.info("started");
    log.error("boom", { err: "nope" });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"level":"info"');
    expect(lines[1]).toContain('"level":"error"');
    expect(lines[1]).toContain('"err":"nope"');
  });
});
