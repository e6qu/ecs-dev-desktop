// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based fuzz tests (fast-check) for API contract input validation.
// Generates random/adversarial values and verifies Zod schemas handle them
// correctly: non-string types are rejected; valid inputs accepted; edge
// cases (empty strings, whitespace, special chars) behave predictably.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createBaseImageRequest,
  createWorkspaceRequest,
  registerSshKeyRequest,
  updateBaseImageRequest,
} from "./index";

describe("createWorkspaceRequest (fuzz)", () => {
  it("rejects any non-string baseImage", () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        const result = createWorkspaceRequest.safeParse({ baseImage: val });
        if (typeof val === "string" && val.length >= 1) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      }),
    );
  });

  it("rejects non-string repoUrl; accepts valid HTTPS URL or undefined", () => {
    fc.assert(
      fc.property(fc.anything(), (repoUrl) => {
        const result = createWorkspaceRequest.safeParse({ baseImage: "golden/node:20", repoUrl });
        if (typeof repoUrl === "string" && isHttpsUrl(repoUrl)) {
          expect(result.success).toBe(true);
        } else if (repoUrl === undefined) {
          expect(result.success).toBe(true);
        } else {
          // Non-URL strings, non-strings → rejected by z.url().startsWith("https://")
          expect(result.success).toBe(false);
        }
      }),
    );
  });
});

/** Lightweight URL check without the URL constructor (not available in this tsconfig). */
function isHttpsUrl(s: string): boolean {
  return s.startsWith("https://") && s.length > 8 && /^https:\/\/[^\s/$.?#].[^\s]*$/.test(s);
}

describe("createBaseImageRequest (fuzz)", () => {
  it("name/image must be non-empty after trimming (whitespace-only rejected)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (name, image) => {
        const result = createBaseImageRequest.safeParse({ name, image });
        expect(result.success).toBe(name.trim().length > 0 && image.trim().length > 0);
      }),
    );
  });

  it("rejects non-string name", () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        const result = createBaseImageRequest.safeParse({ name: val, image: "x" });
        if (typeof val === "string" && val.trim().length > 0) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      }),
    );
  });
});

describe("updateBaseImageRequest (fuzz)", () => {
  it("rejects empty object", () => {
    expect(updateBaseImageRequest.safeParse({}).success).toBe(false);
  });

  it("name must be non-empty after trimming if present", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const result = updateBaseImageRequest.safeParse({ name });
        expect(result.success).toBe(name.trim().length > 0);
      }),
    );
  });

  it("enabled (boolean) alone always accepted", () => {
    fc.assert(
      fc.property(fc.boolean(), (enabled) => {
        expect(updateBaseImageRequest.safeParse({ enabled }).success).toBe(true);
      }),
    );
  });
});

describe("registerSshKeyRequest (fuzz)", () => {
  it("empty publicKey always rejected", () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        if (key.trim().length === 0) {
          expect(registerSshKeyRequest.safeParse({ publicKey: key }).success).toBe(false);
        }
      }),
    );
  });

  it("non-string publicKey rejected", () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        if (typeof val !== "string") {
          expect(registerSshKeyRequest.safeParse({ publicKey: val }).success).toBe(false);
        }
      }),
    );
  });
});
