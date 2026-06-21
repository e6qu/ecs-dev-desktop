// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_WORKSPACE_LOG_STREAM_PREFIX, DEFAULT_WORKSPACE_CONTAINER } from "@edd/config";
import { type LogLevel } from "@edd/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseLevel, workspaceStreamPrefix } from "./cloudwatch-log-source";

const KNOWN_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(["info", "warn", "error"]);

describe("parseLevel (property)", () => {
  it("never throws and always returns a known level for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        let level: LogLevel | undefined;
        expect(() => {
          level = parseLevel(s);
        }).not.toThrow();
        expect(level !== undefined && KNOWN_LEVELS.has(level)).toBe(true);
      }),
    );
  });

  it("never throws on arbitrary JSON-shaped objects, returning a known level", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = JSON.stringify(v);
        let level: LogLevel | undefined;
        expect(() => {
          level = parseLevel(s);
        }).not.toThrow();
        expect(level !== undefined && KNOWN_LEVELS.has(level)).toBe(true);
      }),
    );
  });

  it("a structured JSON level wins over the text heuristic", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LogLevel>("info", "warn", "error"),
        // An arbitrary message that may contain misleading keywords like "error".
        fc.oneof(fc.string(), fc.constantFrom("error happened", "WARNING here", "all good")),
        (structuredLvl, msg) => {
          // A well-formed structured line: the record's `level` must be honoured
          // regardless of what keywords the `msg` text contains.
          const line = JSON.stringify({ level: structuredLvl, service: "x", msg });
          expect(parseLevel(line)).toBe(structuredLvl);
        },
      ),
    );
  });

  it("falls back to the heuristic when the JSON level is not a known level", () => {
    fc.assert(
      fc.property(
        // A level value outside the known set (so structuredLevel returns undefined) AND
        // free of any severity-MARKER token. The heuristic scans the WHOLE serialized line
        // (which embeds `level`), so a non-`info`/`warn`/`error` value that still contains a
        // marker (`err`/`fatal`/`warning`) would legitimately escalate — excluding markers
        // here keeps the test's "clean line → info" precondition actually true.
        fc
          .string()
          .filter(
            (v) =>
              !KNOWN_LEVELS.has(v as LogLevel) && !/\b(error|fatal|err|warn|warning)\b/i.test(v),
          ),
        (badLevel) => {
          // No misleading keywords anywhere in the line → heuristic defaults to "info".
          const line = JSON.stringify({ level: badLevel, msg: "all systems nominal" });
          expect(parseLevel(line)).toBe("info");
        },
      ),
    );
  });
});

describe("workspaceStreamPrefix (property)", () => {
  it("never throws and always yields <prefix>/<container>/<lastSegment>", () => {
    fc.assert(
      fc.property(fc.string(), (arn) => {
        let prefix = "";
        expect(() => {
          prefix = workspaceStreamPrefix(arn);
        }).not.toThrow();
        const head = `${DEFAULT_WORKSPACE_LOG_STREAM_PREFIX}/${DEFAULT_WORKSPACE_CONTAINER}/`;
        expect(prefix.startsWith(head)).toBe(true);
        // The trailing segment is the part of the ARN after the last "/", or the
        // whole value when there is no slash.
        const expectedTail = arn.split("/").pop() ?? arn;
        expect(prefix.slice(head.length)).toBe(expectedTail);
      }),
    );
  });
});
