// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { auth } from "../../auth";
import { BaseImageActions } from "../../components/BaseImageActions";
import { CreateBaseImage } from "../../components/CreateBaseImage";
import { getCatalog } from "../../lib/control-plane";
import { principalFromSession } from "../../lib/principal";

export const dynamic = "force-dynamic";

export default async function BaseImagesPage() {
  const principal = principalFromSession(await auth());
  if (principal === null) {
    return (
      <div className="empty">
        <div className="big">Not signed in</div>
        <p>Sign in to manage the base-image catalog.</p>
        <p style={{ marginTop: 18 }}>
          <Link className="btn primary" href="/login">
            sign in
          </Link>
        </p>
      </div>
    );
  }
  if (principal.role !== "admin") {
    return (
      <div className="empty">
        <div className="big">Admins only</div>
        <p>The base-image catalog is managed by administrators.</p>
      </div>
    );
  }

  const entries = await getCatalog().list();
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">catalog</div>
          <h1>Base images</h1>
          <p>
            The curated golden images users launch workspaces from. Disabled entries stay for
            history but can&rsquo;t start new work.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <CreateBaseImage />
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <div className="big">No base images yet</div>
          <p>Add a golden image above to let users create workspaces from it.</p>
        </div>
      ) : (
        <div className="grid">
          {entries.map((entry, i) => (
            <div
              key={entry.id}
              className="card"
              data-status={entry.enabled ? "running" : "stopped"}
              style={{ animationDelay: `${(i * 40).toString()}ms` }}
            >
              <div className="row">
                <span className="wid">{entry.name}</span>
                <span className="badge">
                  <span className="dot" />
                  {entry.enabled ? "enabled" : "disabled"}
                </span>
              </div>
              <div className="img">{entry.image}</div>
              {entry.description !== "" && <div className="owner">{entry.description}</div>}
              <BaseImageActions id={entry.id} enabled={entry.enabled} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
