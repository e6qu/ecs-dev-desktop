// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const devAuthEnabled = vi.fn();
const shauthOidcConfig = vi.fn();
const shauthEndSessionURL = vi.fn();
const getAuthSessionLogoutContext = vi.fn();
const revokeAuthSession = vi.fn();
const auth = vi.fn();
const signOut = vi.fn();

vi.mock("./principal", () => ({ devAuthEnabled }));
vi.mock("./shauth", () => ({ shauthEndSessionURL, shauthOidcConfig }));
vi.mock("./auth-sessions", () => ({ getAuthSessionLogoutContext, revokeAuthSession }));
vi.mock("../auth", () => ({ auth, signOut }));

const { performSignOut } = await import("./sign-out");

// Deletions happen through set() with an epoch expiry, never delete(): a
// Set-Cookie for a __Secure-/__Host- name without the Secure attribute is
// rejected by the browser, so the expiry must carry it (lib/expire-cookie).
function cookieStore() {
  const setCookie = vi.fn();
  return {
    store: {
      set: setCookie,
      delete: vi.fn(),
      getAll: () => [
        { name: "__Secure-authjs.session-token" },
        { name: "authjs.csrf-token" },
        { name: "unrelated" },
      ],
    },
    setCookie,
  };
}

const expiredSecure = (name: string): unknown =>
  expect.objectContaining({ name, value: "", path: "/", expires: new Date(0), secure: true });
const expired = (name: string): unknown =>
  expect.objectContaining({ name, value: "", path: "/", expires: new Date(0) });

describe("performSignOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devAuthEnabled.mockReturnValue(false);
  });

  it("revokes the local session and returns the Shauth RP-Initiated Logout URL", async () => {
    const { store, setCookie } = cookieStore();
    const config = {
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      logoutBridgeUrl: "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
    };
    shauthOidcConfig.mockReturnValue(config);
    auth.mockResolvedValue({ user: { authSessionId: "app-session" } });
    getAuthSessionLogoutContext.mockResolvedValue({
      provider: "shauth",
      providerIdToken: "provider-id-token",
    });
    shauthEndSessionURL.mockReturnValue("https://auth.dev.e6qu.dev/oauth2/sessions/logout");

    await expect(performSignOut(store)).resolves.toEqual({
      redirectTo: "https://auth.dev.e6qu.dev/oauth2/sessions/logout",
    });

    expect(getAuthSessionLogoutContext).toHaveBeenCalledWith("app-session");
    // The server-side record is revoked SYNCHRONOUSLY: without it, a replayed
    // pre-logout JWT cookie keeps authenticating until Shauth's asynchronous
    // back-channel logout lands.
    expect(revokeAuthSession).toHaveBeenCalledWith("app-session");
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    // The secure-prefixed deletion MUST carry Secure or the browser drops it
    // and the session survives sign-out (measured on the deployed app).
    expect(setCookie).toHaveBeenCalledWith(expiredSecure("__Secure-authjs.session-token"));
    expect(setCookie).toHaveBeenCalledWith(expired("authjs.csrf-token"));
    const expiredNames = setCookie.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(expiredNames).not.toContain("unrelated");
    expect(shauthEndSessionURL).toHaveBeenCalledWith(config, "provider-id-token");
  });

  it("does not claim global Shauth logout for another identity provider", async () => {
    const { store, setCookie } = cookieStore();
    shauthOidcConfig.mockReturnValue({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      logoutBridgeUrl: "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
    });
    auth.mockResolvedValue({ user: { authSessionId: "github-session" } });
    getAuthSessionLogoutContext.mockResolvedValue(null);

    await expect(performSignOut(store)).resolves.toEqual({ redirectTo: "/login" });

    expect(revokeAuthSession).toHaveBeenCalledWith("github-session");
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(setCookie).toHaveBeenCalledWith(expiredSecure("__Secure-authjs.session-token"));
    expect(shauthEndSessionURL).not.toHaveBeenCalled();
  });
});
