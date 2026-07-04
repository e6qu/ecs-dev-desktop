// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isVersionConflict } from "./version-conflict";

describe("isVersionConflict (fuzz)", () => {
  it("never throws on any unknown input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "string",
      "",
      true,
      false,
      {},
      [],
      { message: "ConditionalCheckFailedException" },
      { name: "ConditionalCheckFailedException" },
      { message: "conditional request failed" },
      { name: "Error", message: "something else" },
      Symbol("sym"),
      new Error("random"),
      { cause: { cause: { name: "ConditionalCheckFailedException" } } },
    ];
    for (const input of inputs) {
      expect(() => isVersionConflict(input)).not.toThrow();
    }
  });

  it("does not infinite-loop on a cyclic cause chain", () => {
    const cyclic: Error & { cause?: unknown } = new Error("loop");
    cyclic.cause = cyclic;
    // Should terminate (returns false — no conflict in the message/name),
    // not hang. The cycle guard prevents infinite traversal.
    expect(() => isVersionConflict(cyclic)).not.toThrow();
  });

  it("detects ConditionalCheckFailedException at any depth", () => {
    const deep = new Error("outer");
    deep.cause = new Error("mid");
    (deep.cause as Error).cause = Object.assign(new Error("inner"), {
      name: "ConditionalCheckFailedException",
    });
    expect(isVersionConflict(deep)).toBe(true);
  });

  it("detects 'conditional request failed' message at any depth", () => {
    const deep = new Error("outer");
    deep.cause = new Error("The conditional request failed");
    expect(isVersionConflict(deep)).toBe(true);
  });
});
