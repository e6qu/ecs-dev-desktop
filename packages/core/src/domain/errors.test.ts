// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  conflictError,
  domainErrorMessage,
  invalidError,
  notFoundError,
  type DomainError,
} from "./errors";

describe("DomainError", () => {
  it("constructs each kind with its discriminant", () => {
    expect(notFoundError("workspace", "ws-1")).toEqual({
      kind: "not_found",
      resource: "workspace",
      id: "ws-1",
    });
    expect(conflictError("already stopped")).toEqual({
      kind: "conflict",
      reason: "already stopped",
    });
    expect(invalidError("not in catalog")).toEqual({ kind: "invalid", reason: "not in catalog" });
  });

  it("renders a human message per kind", () => {
    expect(domainErrorMessage(notFoundError("base image", "img-9"))).toBe(
      "base image not found: img-9",
    );
    expect(domainErrorMessage(conflictError("no snapshot"))).toBe("no snapshot");
    expect(domainErrorMessage(invalidError("bad image"))).toBe("bad image");
  });

  it("maps every kind (exhaustive switch compiles)", () => {
    const all: DomainError[] = [
      notFoundError("workspace", "ws-1"),
      conflictError("x"),
      invalidError("y"),
    ];
    for (const e of all) expect(domainErrorMessage(e)).toBeTypeOf("string");
  });
});
