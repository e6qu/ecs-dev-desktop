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

const { localAccountSignIn } = await import("./actions");

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
