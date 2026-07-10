// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto, WorkspaceStateDto } from "@edd/api-contracts";
import { WORKSPACE_PATH_PREFIX } from "@edd/core";

import { gib } from "../lib/format";
import { TESTID } from "../lib/testids";
import { PurgeButton } from "./PurgeButton";
import { ShareToggle } from "./ShareToggle";
import { SnapshotIntervalControl } from "./SnapshotIntervalControl";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";
import { WorkspaceInfo } from "./WorkspaceInfo";

const STAGGER_MS = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Mirrors DEFAULT_UNDELETE_RETENTION_MS (a UI hint only — the service enforces it). */
const UNDELETE_RETENTION_DAYS = 7;

/** Whole days of the undelete window left, floored at 0 (purge imminent). */
function restoreDaysLeft(terminatedAt: string): number {
  const elapsed = Date.now() - Date.parse(terminatedAt);
  return Math.max(0, Math.ceil(UNDELETE_RETENTION_DAYS - elapsed / DAY_MS));
}

function snapshotLabel(at: string | undefined): string {
  if (at === undefined) return "never";
  const elapsed = Math.max(0, Date.now() - Date.parse(at));
  if (elapsed < HOUR_MS) return `${String(Math.max(1, Math.floor(elapsed / MINUTE_MS)))}m ago`;
  if (elapsed < DAY_MS) return `${String(Math.floor(elapsed / HOUR_MS))}h ago`;
  return `${String(Math.floor(elapsed / DAY_MS))}d ago`;
}

/** States where the editor is reachable NOW through the in-app `/w/<id>/` proxy
 * and "Open editor" links straight to it. A stopped workspace is NOT here: it must
 * wake first, so it gets a single "Resume" button that routes through the status
 * page (which wakes it, shows the load progress, and redirects into the editor when
 * ready) rather than dumping the browser on a blank proxy page during the cold start. */
/** Short, human editor-type label for the card badge. */
const EDITOR_LABEL: Record<string, string> = {
  openvscode: "VS Code",
  monaco: "Monaco",
  terminal: "Terminal",
  opencode: "opencode",
};

const READY_STATES: ReadonlySet<WorkspaceStateDto> = new Set(["running", "idle"]);
/** States with meaningful utilization/cost data for the Monitoring link. */
const MONITORABLE_STATES: ReadonlySet<WorkspaceStateDto> = new Set(["running", "idle", "stopped"]);

export function WorkspaceCard({
  ws,
  index,
  canShare = false,
  canUpdateSettings = false,
}: {
  /** A workspace DTO already enriched (catalog image fields + ssh command) by the
   * server / `enrichWorkspace`, so the card is a pure renderer. */
  ws: WorkspaceDto;
  index: number;
  /** True only when the VIEWER owns this workspace: the spectate share toggle is
   * strictly an owner control (the route re-enforces it). */
  canShare?: boolean;
  /** True only when the viewer may PATCH workspace settings for this row. */
  canUpdateSettings?: boolean;
}) {
  const imageName = ws.imageName ?? ws.baseImage;
  const imageDescription = ws.imageDescription ?? "";
  const imageTags = ws.imageTags ?? [];
  const sshCommand = ws.sshCommand;
  // Path-based editor URL served by the control-plane app's in-app proxy.
  const editorHref = `${WORKSPACE_PATH_PREFIX}${ws.id}/`;
  const statusHref = `/workspaces/${ws.id}`;
  // Resume routes through the status page with autoopen so the browser watches the
  // wake (progress + logs) and is redirected into the editor once it is ready.
  const resumeHref = `${statusHref}?autoopen=1`;
  const isReady = READY_STATES.has(ws.state);
  const isStopped = ws.state === "stopped";
  // Never render the raw "start" as its own button: on the card a stopped workspace
  // is woken by the single "Resume" affordance (Start + Open in one), so a separate
  // Start button would be a second control doing the same thing.
  const cardActions = ws.availableActions.filter((action) => action !== "start");
  return (
    <article
      className="card"
      data-testid={TESTID.workspaceCard}
      data-image={ws.baseImage}
      data-status={ws.state}
      style={{ animationDelay: `${index * STAGGER_MS}ms` }}
    >
      <div className="row">
        <span className="wid">{imageName}</span>
        <StatusBadge state={ws.state} />
        <span
          className="badge"
          data-testid={TESTID.workspaceEditorBadge}
          data-editor={ws.editor ?? "openvscode"}
        >
          {EDITOR_LABEL[ws.editor ?? "openvscode"]}
        </span>
        {ws.shareEnabled === true && (
          <span
            className="badge accent"
            data-testid={TESTID.workspaceViewableBadge}
            title="Others can watch this session (spectate)"
          >
            viewable
          </span>
        )}
        <WorkspaceInfo ws={ws} />
        {ws.functional === "degraded" && (
          <span
            className="badge"
            data-status="degraded"
            data-testid={TESTID.workspaceDegraded}
            title="The desktop is running but not fully usable (IDE or workspace storage)."
            aria-label="degraded — running but not fully usable"
          >
            <span className="dot" aria-hidden="true" />
            degraded
          </span>
        )}
      </div>
      <div className="subhead mono">{ws.id}</div>
      {ws.state === "terminated" && ws.terminatedAt !== undefined && (
        <div className="meta-line">
          <span className="meta-label">deleted</span>
          <span className="meta-value mono">
            {new Date(ws.terminatedAt).toLocaleString()} — restorable for{" "}
            {restoreDaysLeft(ws.terminatedAt)} more day(s)
          </span>
        </div>
      )}
      <div className="meta-line">
        <span className="meta-label">size</span>
        <span className="meta-value mono">
          {ws.resources.cpuUnits / 1024} vCPU · {ws.resources.memoryMiB / 1024} GiB mem ·{" "}
          {ws.diskUsedBytes !== undefined
            ? `disk ${gib(ws.diskUsedBytes)} / ${ws.resources.volumeGiB} GiB`
            : `${ws.resources.volumeGiB} GiB disk`}
        </span>
      </div>
      <div
        className="meta-line"
        data-testid={TESTID.workspaceSnapshot}
        data-snapshot-at={ws.latestSnapshotAt ?? ""}
      >
        <span className="meta-label">last snapshot</span>
        <span className="meta-value mono">{snapshotLabel(ws.latestSnapshotAt)}</span>
      </div>
      {canUpdateSettings ? (
        <SnapshotIntervalControl id={ws.id} valueMs={ws.snapshotIntervalMs} />
      ) : (
        ws.snapshotIntervalMs !== undefined && (
          <div className="meta-line">
            <span className="meta-label">snapshot interval</span>
            <span className="meta-value mono">
              {String(Math.round(ws.snapshotIntervalMs / 60000))} min
            </span>
          </div>
        )
      )}
      <div className="img">{ws.baseImage}</div>
      {imageDescription !== "" && <div className="desc">{imageDescription}</div>}
      {imageTags.length > 0 && (
        <div className="pill-row" style={{ marginTop: 12 }}>
          {imageTags.map((tag) => (
            <span key={tag} className="pill">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="owner" data-testid={TESTID.workspaceOwner}>
        started by · {ws.ownerEmail ?? ws.ownerId}
      </div>
      {sshCommand !== undefined && (
        <div className="meta-line">
          <span className="meta-label">ssh</span>
          <code
            className="meta-value"
            data-testid={TESTID.workspaceSshCommand}
            data-host={sshCommand}
            style={{ wordBreak: "break-all" }}
          >
            {sshCommand}
          </code>
        </div>
      )}
      <div className="meta-line" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isReady && (
          <a
            className="btn primary"
            href={editorHref}
            data-testid={TESTID.workspaceOpen}
            data-href={editorHref}
          >
            Open editor
          </a>
        )}
        {isStopped && (
          <a
            className="btn primary"
            href={resumeHref}
            data-testid={TESTID.workspaceResume}
            data-href={resumeHref}
          >
            Resume
          </a>
        )}
        {/* A proper status page, linked directly from every card: watch a not-yet-
            loaded workspace come up (phase stepper + live boot logs) and reach the
            editor when ready. Redundant with Resume for a stopped workspace (which
            already routes here), so shown for every OTHER state. */}
        {!isStopped && (
          <a className="btn" href={statusHref} data-testid={TESTID.workspaceStatusLink}>
            Status
          </a>
        )}
        {MONITORABLE_STATES.has(ws.state) && (
          <a
            className="btn"
            href={`/workspaces/${ws.id}/monitoring`}
            data-testid={TESTID.workspaceMonitoringLink}
          >
            Monitoring
          </a>
        )}
      </div>
      {canShare && (isReady || ws.shareEnabled === true) && (
        <ShareToggle id={ws.id} enabled={ws.shareEnabled === true} />
      )}
      {!canShare && ws.shareEnabled === true && (
        <div className="meta-line">
          <a className="btn" href={`/workspaces/${ws.id}/spectate`}>
            Spectate (read-only)
          </a>
        </div>
      )}
      <WorkspaceActions id={ws.id} actions={cardActions} />
      {ws.state === "terminated" && (
        <div className="meta-line">
          <PurgeButton id={ws.id} />
        </div>
      )}
    </article>
  );
}
