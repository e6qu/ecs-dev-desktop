// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { tableDefinition } from "./index";

describe("tableDefinition", () => {
  it("defines the PK/SK primary key and both GSIs", () => {
    const def = tableDefinition("t");
    expect(def.KeySchema.map((k) => k.AttributeName)).toEqual(["PK", "SK"]);
    expect(def.GlobalSecondaryIndexes.map((g) => g.IndexName)).toEqual(["GSI1", "GSI2"]);
  });
});
