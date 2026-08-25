// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookies = vi.fn();
const redirect = vi.fn();
const devAuthEnabled = vi.fn();
const shauthOidcConfig = vi.fn();
const shauthEndSessionURL = vi.fn();
const getAuthSessionLogoutContext = vi.fn();
const revokeAuthSession = vi.fn();
const auth = vi.fn();
const signOut = vi.fn();
const signIn = vi.fn();

vi.mock("next/headers", () => ({ cookies }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../lib/principal", () => ({ devAuthEnabled }));
vi.mock("../../lib/shauth", () => ({ shauthEndSessionURL, shauthOidcConfig }));
vi.mock("../../lib/auth-sessions", () => ({ getAuthSessionLogoutContext, revokeAuthSession }));
vi.mock("../../auth", () => ({ auth, signIn, signOut }));

const { localAccountSignIn, signOutAction } = await import("./actions");

function cookieStore() {
  // Deletions happen through set() with an epoch expiry, never delete():
  // a Set-Cookie for a __Secure-/__Host- name without the Secure attribute is
  // rejected by the browser, so the expiry must carry it (lib/expire-cookie).
  const setCookie = vi.fn();
  cookies.mockResolvedValue({
    set: setCookie,
    getAll: () => [
      { name: "__Secure-authjs.session-token", value: "session" },
      { name: "authjs.csrf-token", value: "csrf" },
      { name: "unrelated", value: "keep" },
    ],
  });
  return setCookie;
}

const expiredSecure = (name: string): unknown =>
  expect.objectContaining({ name, value: "", path: "/", expires: new Date(0), secure: true });
const expired = (name: string): unknown =>
  expect.objectContaining({ name, value: "", path: "/", expires: new Date(0) });

describe("signOutAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devAuthEnabled.mockReturnValue(false);
    redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("revokes the local session and enters Shauth RP-Initiated Logout", async () => {
    const setCookie = cookieStore();
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

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");

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
    expect(redirect).toHaveBeenCalledWith("https://auth.dev.e6qu.dev/oauth2/sessions/logout");
  });

  it("does not claim global Shauth logout for another identity provider", async () => {
    const setCookie = cookieStore();
    shauthOidcConfig.mockReturnValue({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      logoutBridgeUrl: "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
    });
    auth.mockResolvedValue({ user: { authSessionId: "github-session" } });
    getAuthSessionLogoutContext.mockResolvedValue(null);

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(revokeAuthSession).toHaveBeenCalledWith("github-session");
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(setCookie).toHaveBeenCalledWith(expiredSecure("__Secure-authjs.session-token"));
    expect(shauthEndSessionURL).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

describe("localAccountSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devAuthEnabled.mockReturnValue(false);
    redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("turns rejected local credentials into a stable login error", async () => {
    signIn.mockRejectedValue(
      Object.assign(new Error("invalid credentials"), { type: "CredentialsSignin" }),
    );
    const form = new FormData();
    form.set("email", "unknown@example.com");
    form.set("password", "wrong-password");

    await expect(localAccountSignIn(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(signIn).toHaveBeenCalledWith("credentials", {
      email: "unknown@example.com",
      password: "wrong-password",
      redirectTo: "/workspaces",
    });
    expect(redirect).toHaveBeenCalledWith("/login?error=CredentialsSignin");
  });
});
