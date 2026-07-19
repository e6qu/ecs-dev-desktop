// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const signIn = vi.fn();
const redirect = vi.fn();
const shauthEnabled = vi.fn();

vi.mock("../../../auth", () => ({ signIn }));
vi.mock("../../../lib/shauth", () => ({ shauthEnabled }));
vi.mock("next/navigation", () => ({ redirect }));

const { GET } = await import("./route");

describe("GET /login/shauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the Shauth provider from the route-handler request context", async () => {
    shauthEnabled.mockReturnValue(true);
    signIn.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(GET()).rejects.toThrow("NEXT_REDIRECT");
    expect(signIn).toHaveBeenCalledWith("shauth", { redirectTo: "/workspaces" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns to login when Shauth is not configured", async () => {
    shauthEnabled.mockReturnValue(false);
    redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(GET()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login?error=Configuration");
    expect(signIn).not.toHaveBeenCalled();
  });
});
