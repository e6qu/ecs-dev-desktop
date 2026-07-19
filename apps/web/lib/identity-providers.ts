// SPDX-License-Identifier: AGPL-3.0-or-later

type Environment = Record<string, string | undefined>;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

function optionalOAuthClient(
  provider: string,
  clientIdEnvironment: string,
  clientSecretEnvironment: string,
  environment: Environment,
): OAuthClientCredentials | null {
  const clientId = environment[clientIdEnvironment]?.trim() ?? "";
  const clientSecret = environment[clientSecretEnvironment]?.trim() ?? "";
  if (clientId === "" && clientSecret === "") return null;
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      `${provider} requires ${clientIdEnvironment} and ${clientSecretEnvironment} together`,
    );
  }
  return { clientId, clientSecret };
}

export function githubOAuthClient(
  environment: Environment = process.env,
): OAuthClientCredentials | null {
  return optionalOAuthClient("GitHub OAuth", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", environment);
}

export function entraOAuthClient(
  environment: Environment = process.env,
): OAuthClientCredentials | null {
  return optionalOAuthClient(
    "Microsoft Entra ID",
    "AUTH_MICROSOFT_ENTRA_ID_ID",
    "AUTH_MICROSOFT_ENTRA_ID_SECRET",
    environment,
  );
}
