// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookies = vi.fn();
const redirect = vi.fn();
const devAuthEnabled = vi.fn();
const shauthOidcConfig = vi.fn();
const shauthEndSessionURL = vi.fn();
const getAuthSessionLogoutContext = vi.fn();
const auth = vi.fn();
const signOut = vi.fn();

vi.mock("next/headers", () => ({ cookies }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../lib/principal", () => ({ devAuthEnabled }));
vi.mock("../../lib/shauth", () => ({ shauthEndSessionURL, shauthOidcConfig }));
vi.mock("../../lib/auth-sessions", () => ({ getAuthSessionLogoutContext }));
vi.mock("../../auth", () => ({ auth, signOut }));

const { signOutAction } = await import("./actions");

function cookieStore() {
  const deleteCookie = vi.fn();
  cookies.mockResolvedValue({
    delete: deleteCookie,
    getAll: () => [
      { name: "__Secure-authjs.session-token", value: "session" },
      { name: "authjs.csrf-token", value: "csrf" },
      { name: "unrelated", value: "keep" },
    ],
  });
  return deleteCookie;
}

describe("signOutAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devAuthEnabled.mockReturnValue(false);
    redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("revokes the local session and enters Shauth RP-Initiated Logout", async () => {
    const deleteCookie = cookieStore();
    const config = {
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: "https://app.edd.dev.e6qu.dev/signed-out",
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
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(deleteCookie).toHaveBeenCalledWith("__Secure-authjs.session-token");
    expect(deleteCookie).toHaveBeenCalledWith("authjs.csrf-token");
    expect(deleteCookie).not.toHaveBeenCalledWith("unrelated");
    expect(shauthEndSessionURL).toHaveBeenCalledWith(config, "provider-id-token");
    expect(redirect).toHaveBeenCalledWith(
      "https://auth.dev.e6qu.dev/oauth2/sessions/logout",
    );
  });

  it("does not claim global Shauth logout for another identity provider", async () => {
    const deleteCookie = cookieStore();
    shauthOidcConfig.mockReturnValue({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: "https://app.edd.dev.e6qu.dev/signed-out",
    });
    auth.mockResolvedValue({ user: { authSessionId: "github-session" } });
    getAuthSessionLogoutContext.mockResolvedValue(null);

    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(deleteCookie).toHaveBeenCalledWith("__Secure-authjs.session-token");
    expect(shauthEndSessionURL).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
