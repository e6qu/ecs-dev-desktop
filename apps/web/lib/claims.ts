// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IdentityClaims } from "@edd/auth";
import { z } from "zod";

const githubProfile = z.object({ id: z.union([z.number(), z.string()]) });
const entraProfile = z.object({
  oid: z.string().optional(),
  sub: z.string().optional(),
  groups: z.array(z.string()).optional(),
});
const shauthProfile = z.object({
  sub: z.string().min(1),
  role: z.enum(["developer", "admin"]),
});

/**
 * Normalise a provider's profile into typed {@link IdentityClaims}. The untyped
 * provider profile is parsed at this edge (Zod) into a domain shape; unknown
 * providers fail loudly.
 */
export function normalizeClaims(provider: string, profile: unknown): IdentityClaims {
  switch (provider) {
    case "github": {
      const p = githubProfile.parse(profile);
      return { idp: "github", subject: String(p.id), groups: [] };
    }
    case "microsoft-entra-id": {
      const p = entraProfile.parse(profile);
      const subject = p.oid ?? p.sub;
      if (subject === undefined) throw new Error("entra profile missing oid/sub");
      return { idp: "entra", subject, groups: p.groups ?? [] };
    }
    case "shauth": {
      const p = shauthProfile.parse(profile);
      return { idp: "shauth", subject: p.sub, groups: [], role: p.role };
    }
    default:
      throw new Error(`unsupported auth provider: ${provider}`);
  }
}
