// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { invitationEmail, invitationUrl } from "./invitation-mailer";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invitation mailer", () => {
  it("builds an invitation URL from the configured public app URL", () => {
    vi.stubEnv("EDD_PUBLIC_APP_URL", "https://app.example.com/base");

    expect(invitationUrl("tok/en")).toBe("https://app.example.com/invitation/tok%2Fen");
  });

  it("builds the SES SendEmail input without hidden defaults", () => {
    vi.stubEnv("EDD_PUBLIC_APP_URL", "https://app.example.com");
    vi.stubEnv("EDD_EMAIL_FROM", "EDD <noreply@example.com>");

    const email = invitationEmail({ email: "dev@example.com", token: "tok" });

    expect(email.FromEmailAddress).toBe("EDD <noreply@example.com>");
    expect(email.Destination?.ToAddresses).toEqual(["dev@example.com"]);
    expect(email.Content?.Simple?.Subject?.Data).toBe("Your EDD workspace invitation");
    expect(email.Content?.Simple?.Body?.Text?.Charset).toBe("UTF-8");
    expect(email.Content?.Simple?.Body?.Text?.Data).toContain(
      "https://app.example.com/invitation/tok",
    );
  });

  it("fails loudly when the sender is not configured", () => {
    vi.stubEnv("EDD_PUBLIC_APP_URL", "https://app.example.com");

    expect(() => invitationEmail({ email: "dev@example.com", token: "tok" })).toThrow(
      "EDD_EMAIL_FROM is required",
    );
  });
});
