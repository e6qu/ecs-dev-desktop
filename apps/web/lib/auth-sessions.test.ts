// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const sessionGetGo = vi.fn();
const sessionGet = vi.fn(() => ({ go: sessionGetGo }));
const sessionPatchGo = vi.fn();
const sessionPatchSet = vi.fn(() => ({ go: sessionPatchGo }));
const sessionPatch = vi.fn(() => ({ set: sessionPatchSet }));
const correlationPatchGo = vi.fn();
const correlationPatchSet = vi.fn(() => ({ go: correlationPatchGo }));
const correlationPatch = vi.fn(() => ({ set: correlationPatchSet }));

vi.mock("@edd/db", () => ({
  createDynamoClient: vi.fn(() => ({})),
  makeAuthSessionEntity: vi.fn(() => ({ get: sessionGet, patch: sessionPatch })),
  makeAuthSessionCorrelationEntity: vi.fn(() => ({ patch: correlationPatch })),
  makeOidcLogoutTokenEntity: vi.fn(() => ({})),
  writeTransaction: vi.fn(),
}));
vi.mock("./control-plane", () => ({ tableName: () => "edd-auth-sessions-unit" }));

const { AUTH_SESSION_SCHEMA_VERSION, validateAuthSessionToken } = await import("./auth-sessions");

const NOW_MS = Date.parse("2026-08-02T12:00:00.000Z");

const token = {
  authSessionId: "session-1",
  authSessionVersion: AUTH_SESSION_SCHEMA_VERSION,
  uid: "user-1",
  role: "developer",
} as const;

function activeSessionRow() {
  return {
    id: "session-1",
    schemaVersion: AUTH_SESSION_SCHEMA_VERSION,
    ownerId: "user-1",
    role: "developer",
    provider: "shauth",
    providerSubject: "user-1",
    providerSessionId: "provider-session-1",
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    refreshedAt: new Date(NOW_MS - 60_000).toISOString(),
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
  };
}

describe("validateAuthSessionToken store-failure handling", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionPatchGo.mockResolvedValue({ data: {} });
    correlationPatchGo.mockResolvedValue({ data: {} });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("reads the session with strong consistency", async () => {
    sessionGetGo.mockResolvedValue({ data: activeSessionRow() });

    await expect(validateAuthSessionToken(token, NOW_MS)).resolves.toMatchObject({
      id: "session-1",
      ownerId: "user-1",
      role: "developer",
    });
    expect(sessionGet).toHaveBeenCalledWith({ id: "session-1" });
    expect(sessionGetGo).toHaveBeenCalledWith({ consistent: true });
  });

  it("propagates a session-store read failure instead of returning null", async () => {
    sessionGetGo.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(validateAuthSessionToken(token, NOW_MS)).rejects.toThrow("DynamoDB unavailable");
    expect(sessionPatch).not.toHaveBeenCalled();
  });

  it("keeps the session valid when the rolling refresh writes fail", async () => {
    sessionGetGo.mockResolvedValue({ data: activeSessionRow() });
    sessionPatchGo.mockRejectedValue(new Error("refresh UpdateItem throttled"));
    correlationPatchGo.mockRejectedValue(new Error("correlation UpdateItem throttled"));

    await expect(validateAuthSessionToken(token, NOW_MS)).resolves.toMatchObject({
      id: "session-1",
      ownerId: "user-1",
      role: "developer",
      expiresAtMs: NOW_MS + 60_000,
    });
    expect(sessionPatch).toHaveBeenCalledWith({ id: "session-1" });
    expect(correlationPatch).toHaveBeenCalledTimes(2);
    // The fire-and-forget writes reject after the validation result resolved;
    // each failure is caught and logged, never surfaced to the caller.
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(3);
    });
  });

  it("still returns null for an absent session", async () => {
    sessionGetGo.mockResolvedValue({ data: null });

    await expect(validateAuthSessionToken(token, NOW_MS)).resolves.toBeNull();
    expect(sessionPatch).not.toHaveBeenCalled();
  });

  it("still returns null for an expired session without refreshing it", async () => {
    sessionGetGo.mockResolvedValue({
      data: { ...activeSessionRow(), expiresAt: new Date(NOW_MS - 1).toISOString() },
    });

    await expect(validateAuthSessionToken(token, NOW_MS)).resolves.toBeNull();
    expect(sessionPatch).not.toHaveBeenCalled();
    expect(correlationPatch).not.toHaveBeenCalled();
  });
});
