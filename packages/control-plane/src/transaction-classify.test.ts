// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { fatalTransactionCode } from "./workspace-service";

describe("fatalTransactionCode", () => {
  it("flags a permanent data error (ValidationError) as fatal", () => {
    expect(fatalTransactionCode({ data: [{ code: "None" }, { code: "ValidationError" }] })).toBe(
      "ValidationError",
    );
  });

  it("flags an item-collection size-limit breach as fatal", () => {
    expect(fatalTransactionCode({ data: [{ code: "ItemCollectionSizeLimitExceeded" }] })).toBe(
      "ItemCollectionSizeLimitExceeded",
    );
  });

  it("treats a conditional-check loss (the optimistic-CAS race) as non-fatal — a conflict", () => {
    expect(fatalTransactionCode({ data: [{ code: "ConditionalCheckFailed" }] })).toBeUndefined();
  });

  it("treats transient contention (TransactionConflict / throttling) as non-fatal", () => {
    expect(fatalTransactionCode({ data: [{ code: "TransactionConflict" }] })).toBeUndefined();
    expect(fatalTransactionCode({ data: [{ code: "ThrottlingError" }] })).toBeUndefined();
  });

  it("tolerates missing / empty / null items (defaults to the conflict path)", () => {
    expect(fatalTransactionCode({})).toBeUndefined();
    expect(fatalTransactionCode({ data: [] })).toBeUndefined();
    expect(fatalTransactionCode({ data: [null, undefined, {}] })).toBeUndefined();
  });
});
