// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  AUTO_SIGN_IN_MARKER,
  SIGNING_OUT_MARKER,
  clearAutoSignInMarkers,
  decideAutoSignIn,
  markSigningOut,
  type MarkerStorage,
} from "./shauth-auto-sign-in";

function memoryStorage(): MarkerStorage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

const now = (): string => "2026-09-07T12:16:13.000Z";

describe("decideAutoSignIn", () => {
  it("enters Shauth on the first signed-out render of a tab and marks the attempt", () => {
    const storage = memoryStorage();
    expect(decideAutoSignIn(storage, now)).toBe("redirect");
    expect(storage.entries.get(AUTO_SIGN_IN_MARKER)).toBe(now());
  });

  it("holds when the previous auto-entry produced no session, so the tab cannot loop", () => {
    const storage = memoryStorage();
    decideAutoSignIn(storage, now);
    expect(decideAutoSignIn(storage, now)).toBe("hold");
  });

  it("never starts a sign-in underneath an in-flight sign-out", () => {
    // The regression: /workspaces LiveRefresh re-rendered the route after the
    // sign-out POST had cleared the session cookie but before the logout redirect
    // chain reached /signed-out. The signed-out render auto-entered Shauth and
    // location.replace cancelled the logout navigation.
    const storage = memoryStorage();
    markSigningOut(storage, now);
    expect(decideAutoSignIn(storage, now)).toBe("signing-out");
    // A hold that did not even set the auto-entry marker: the next settled
    // signed-out render in this tab (after the landing clears the markers) is
    // free to auto-enter again.
    expect(storage.entries.has(AUTO_SIGN_IN_MARKER)).toBe(false);
  });

  it("gives sign-out precedence over a stale auto-entry marker", () => {
    const storage = memoryStorage();
    decideAutoSignIn(storage, now);
    markSigningOut(storage, now);
    expect(decideAutoSignIn(storage, now)).toBe("signing-out");
  });
});

describe("clearAutoSignInMarkers", () => {
  it("settles the tab so a later signed-out render auto-enters again", () => {
    const storage = memoryStorage();
    decideAutoSignIn(storage, now);
    markSigningOut(storage, now);
    clearAutoSignInMarkers(storage);
    expect(storage.entries.has(AUTO_SIGN_IN_MARKER)).toBe(false);
    expect(storage.entries.has(SIGNING_OUT_MARKER)).toBe(false);
    expect(decideAutoSignIn(storage, now)).toBe("redirect");
  });
});
