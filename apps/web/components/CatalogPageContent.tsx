// SPDX-License-Identifier: AGPL-3.0-or-later
import { BaseImageActions } from "./BaseImageActions";
import { CreateBaseImage } from "./CreateBaseImage";
import { TESTID } from "../lib/testids";
import type { BaseImageEntryDto } from "@edd/api-contracts";

export function CatalogPageContent({ entries }: { entries: readonly BaseImageEntryDto[] }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">catalog</div>
          <h1>Base images</h1>
          <p>
            The curated golden images users launch workspaces from. Disabled entries stay for
            history but can&apos;t start new work.
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
              data-testid={TESTID.catalogCard}
              data-image={entry.image}
              data-enabled={entry.enabled}
              data-tags={entry.tags.join(",")}
              data-tools={entry.tools.join(",")}
              data-status={entry.enabled ? "running" : "stopped"}
              style={{ animationDelay: `${(i * 40).toString()}ms` }}
            >
              <div className="row">
                <span className="wid">{entry.name}</span>
                <span className="badge">
                  <span className="dot" aria-hidden="true" />
                  {entry.enabled ? "enabled" : "disabled"}
                </span>
              </div>
              <div className="img">{entry.image}</div>
              {entry.description !== "" && <div className="owner">{entry.description}</div>}
              {(entry.tags.length > 0 || entry.tools.length > 0) && (
                <div className="stack" style={{ gap: 10, marginTop: 12 }}>
                  {entry.tags.length > 0 && (
                    <div className="pill-row">
                      {entry.tags.map((tag) => (
                        <span key={tag} className="pill">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {entry.tools.length > 0 && (
                    <div className="meta-line">
                      <span className="meta-label">tools</span>
                      <span className="meta-value">{entry.tools.join(" · ")}</span>
                    </div>
                  )}
                </div>
              )}
              <BaseImageActions id={entry.id} enabled={entry.enabled} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
