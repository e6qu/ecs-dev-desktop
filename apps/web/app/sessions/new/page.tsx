// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { NewSession } from "../../../components/NewSession";
import { getCatalog } from "../../../lib/control-plane";
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
      <div className="empty">
        <div className="big">Not signed in</div>
        <p>Sign in to start a session.</p>
        <p style={{ marginTop: 18 }}>
          <Link className="btn primary" href="/login">
            sign in
          </Link>
        </p>
      </div>
    );
  }

  const images = (await getCatalog().list())
    .filter((entry) => entry.enabled)
    .map((entry) => ({ name: entry.name, image: entry.image }));

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
