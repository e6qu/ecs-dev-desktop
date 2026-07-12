// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineAbilityFor } from "@edd/authz";

import { NewSession } from "../../../components/NewSession";
import { StateBlock } from "../../../components/StateBlock";
import { getCatalogList } from "../../../lib/control-plane";
import { getPagePrincipal } from "../../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * New-session launcher: choose an environment and start a session from a GitHub
 * repo (existing or freshly created) or blank. Repo data is fetched client-side
 * from the server-side `/api/github/*` routes so the user's token never reaches
 * the browser.
 */
export default async function NewSessionPage() {
  const principal = await getPagePrincipal();
  if (principal === null) {
    return (
      <StateBlock
        title="Not signed in"
        detail="Sign in to start a session."
        action={{ href: "/login", label: "sign in" }}
      />
    );
  }

  // A viewer can't create workspaces — gate the launcher here (the API would 403 anyway) so they
  // get a clear read-only message instead of a dead-end error after picking an image. Mirrors the
  // workspaces page's read-only treatment.
  if (!defineAbilityFor(principal).can("create", "Workspace")) {
    return (
      <StateBlock
        title="Read-only access"
        detail="Your role can't create workspaces — ask an admin if you need one."
        action={{ href: "/workspaces", label: "back to workspaces" }}
      />
    );
  }

  const images = (await getCatalogList())
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      name: entry.name,
      image: entry.image,
      description: entry.description,
      tags: entry.tags,
      tools: entry.tools,
    }));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">new session</div>
          <h1>Start a session</h1>
          <p>Pick an environment and a repository — your code, one repo per session.</p>
        </div>
      </div>
      <NewSession images={images} />
    </>
  );
}
