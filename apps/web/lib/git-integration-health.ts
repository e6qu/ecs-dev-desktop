// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComponentHealth } from "@edd/core";

import { listAppInstallations } from "./git-app-auth";
import { gitIntegration } from "./git-integration";
import { githubAppConfig } from "./git-provider";

/**
 * The Health board's `git-integration` row: which git-access path this deployment offers
 * sessions, verified live where possible. A GitHub App is exercised (its installations are
 * listed with a freshly signed app JWT — the same call the launcher relies on), so a wrong
 * key or an uninstalled App shows here before a user hits it. A deployment with neither an
 * App nor account linking is `degraded`: sessions can still clone public repositories over
 * HTTPS and private ones with user-generated SSH keys, but repositories cannot be browsed
 * or created, and admins should know that is by omission, not by choice.
 */
export async function gitIntegrationHealth(): Promise<ComponentHealth> {
  const component = "git-integration";
  const integration = gitIntegration();
  const sshNote = integration.sshKeys
    ? "user SSH keys on"
    : "user SSH keys off (no EDD_TOKEN_ENC_KEY)";
  switch (integration.tokens) {
    case "app": {
      const cfg = githubAppConfig();
      if (cfg === null) {
        return { component, status: "down", detail: "GitHub App configured but unreadable" };
      }
      try {
        const installations = await listAppInstallations(cfg, Math.floor(Date.now() / 1000));
        const accounts = installations
          .map((inst) => inst.account?.login)
          .filter((login): login is string => login !== undefined);
        if (installations.length === 0) {
          return {
            component,
            status: "degraded",
            detail: `GitHub App reachable but installed nowhere; ${sshNote}`,
          };
        }
        return {
          component,
          status: "ok",
          detail: `GitHub App installed on ${accounts.join(", ")}; ${sshNote}`,
        };
      } catch (error) {
        return {
          component,
          status: "down",
          detail: `GitHub App check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    case "oauth":
      return { component, status: "ok", detail: `GitHub account linking; ${sshNote}` };
    case "none":
      return {
        component,
        status: "degraded",
        detail: `no GitHub App or account linking: public HTTPS clones only; ${sshNote}`,
      };
  }
}
