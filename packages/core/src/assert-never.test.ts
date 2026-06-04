// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { assertNever } from "./assert-never";

describe("assertNever", () => {
  it("throws if an unexpected value reaches it at runtime", () => {
    // The compile-time guarantee is the point; this covers the runtime backstop
    // (e.g. malformed data slipping past the types). The cast is the only way to
    // reach it from a test.
    expect(() => assertNever("unexpected" as never)).toThrow(/unreachable/);
  });
});
