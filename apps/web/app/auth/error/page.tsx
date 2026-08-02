// SPDX-License-Identifier: AGPL-3.0-or-later
import { ShauthSignInLink } from "../../../components/ShauthSignInLink";

/**
 * Where Auth.js sends a sign-in that failed. Its own page reports nothing an
 * operator can act on, and in a deployment whose container logs are not
 * collected that left a failing callback with no observable cause at all — the
 * condition that blocked #257. The `error` Auth.js passes is a fixed set of
 * codes, not free text, so naming it here leaks nothing.
 */
const EXPLANATIONS: Record<string, string> = {
  Configuration:
    "The server could not complete the sign-in. This is a deployment problem, not a credential problem: the identity provider was unreachable from the server, or its configuration is wrong.",
  AccessDenied: "The identity provider refused this account access to this application.",
  Verification: "The sign-in link is no longer valid.",
};

export const dynamic = "force-dynamic";

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).error;
  const code = typeof raw === "string" && raw.length > 0 ? raw : "Default";
  return (
    <main data-testid="auth-error">
      <h1>Sign-in did not complete</h1>
      <p data-testid="auth-error-code">{code}</p>
      <p>{EXPLANATIONS[code] ?? "The sign-in did not complete."}</p>
      <ShauthSignInLink />
    </main>
  );
}
