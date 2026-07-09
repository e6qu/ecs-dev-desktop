// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./passwords";

describe("password hashing", () => {
  it("verifies the original password and rejects a different one", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", encoded)).resolves.toBe(true);
    await expect(verifyPassword("correct horse battery staple!", encoded)).resolves.toBe(false);
  });

  it("uses a fresh salt per hash", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
  });

  it("fails loudly on unsupported hash versions", async () => {
    await expect(verifyPassword("pw", "plain-v0:salt:value")).rejects.toThrow(
      "unsupported password hash version",
    );
  });
});
