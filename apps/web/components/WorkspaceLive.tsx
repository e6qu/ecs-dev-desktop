// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient, ApiError } from "@edd/api-client";
import type { WorkspaceDto, WorkspaceLogsDto } from "@edd/api-contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { TESTID } from "../lib/testids";
import { usePoll } from "../lib/usePoll";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";

const api = new ApiClient({ baseUrl: "" });
const STATUS_POLL_MS = 1000;
const LOGS_POLL_MS = 4000;
/** Seconds the "opening editor" countdown runs before auto-navigating. */
const AUTO_OPEN_COUNTDOWN_S = 3;
/** The record is gone (deleted + purged, or never existed). */
const HTTP_NOT_FOUND = 404;
/** Lifecycle conflict: the wake we asked for already happened / is in flight. */
const HTTP_CONFLICT = 409;
/** How close (px) to the bottom of the log panel still counts as "pinned" —
 * only then does a new line auto-scroll the tail into view. */
const LOG_PIN_THRESHOLD_PX = 8;

type StepState = "done" | "active" | "pending" | "failed";

interface Step {
  label: string;
  state: StepState;
}

/** The provisioning phases, derived purely from state + the agent's functional
 * report (the same signals the reconciler trusts). Works for both a fresh
 * create and a wake-from-snapshot — `provisioning` covers the launch (image
 * pull + managed-EBS attach, the long part on first start). */
function provisioningSteps(ws: WorkspaceDto): Step[] {
  const failed = ws.state === "error";
  const launching = ws.state === "provisioning";
  const booting = ws.state === "running" && ws.functional === undefined;
  const ready = ws.state === "running" && ws.functional === "ok";
  const after = (done: boolean, active: boolean): StepState =>
    done ? "done" : active ? (failed ? "failed" : "active") : failed ? "failed" : "pending";
  return [
    { label: "Session created", state: "done" },
    {
      label: "Launching compute (image pull + storage attach)",
      state: after(booting || ready || ws.functional === "degraded", launching),
    },
    { label: "Starting editor", state: after(ready, booting) },
    { label: "Ready", state: ready ? "done" : failed ? "failed" : "pending" },
  ];
}

function StepDot({ state }: { state: StepState }) {
  const glyph = state === "done" ? "✓" : state === "failed" ? "✕" : state === "active" ? "●" : "○";
  const color =
    state === "done"
      ? "var(--accent, #9fef00)"
      : state === "failed"
        ? "var(--st-error, #ff6b6b)"
        : state === "active"
          ? "var(--accent, #9fef00)"
          : "var(--dim)";
  return (
    <span aria-hidden="true" style={{ color, width: 16, display: "inline-block" }}>
      {glyph}
    </span>
  );
}

function elapsedSince(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return s >= 60 ? `${String(Math.floor(s / 60))}m ${String(s % 60)}s` : `${String(s)}s`;
}

/**
 * Live per-workspace status view (/workspaces/[id]): what a user lands on right
 * after starting a session. Polls the workspace itself plus its container log
 * slice, and keys "ready" off the agent's `functional` self-report — NOT `state`:
 * a fresh workspace's DB state is `running` the moment ECS accepts the task,
 * while the container may still be pulling/booting for a minute or two. The
 * first heartbeat's functional=ok is the real "your desktop is usable" signal.
 */
export function WorkspaceLive({ id }: { id: string }) {
  const loadWs = useCallback(() => api.getWorkspace(id), [id]);
  const loadLogs = useCallback(() => api.getWorkspaceLogs(id), [id]);
  const {
    data: ws,
    error,
    errorStatus,
  } = usePoll<WorkspaceDto>(loadWs, STATUS_POLL_MS, "workspace not found");
  const { data: logs } = usePoll<WorkspaceLogsDto>(loadLogs, LOGS_POLL_MS, "logs unavailable");

  // Auto-open: only on the launch-initiated visit (?autoopen=1 from the session
  // launcher), never on later direct visits. Read from location in an effect so
  // SSR markup never depends on the query string.
  const [autoOpen, setAutoOpen] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("autoopen") === "1") setAutoOpen(true);
  }, []);
  const isReady = ws !== null && ws.state === "running" && ws.functional === "ok";
  useEffect(() => {
    if (!autoOpen || !isReady || countdown !== null) return;
    setCountdown(AUTO_OPEN_COUNTDOWN_S);
  }, [autoOpen, isReady, countdown]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      window.location.assign(`/w/${id}/`);
      return;
    }
    const t = window.setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);
    return () => {
      window.clearTimeout(t);
    };
  }, [countdown, id]);

  // Resume: waking a stopped workspace and dropping the user back into the editor
  // is driven from this page (the card's "Resume" links here with ?autoopen=1).
  // `resume()` kicks the wake and arms auto-open so the page redirects into the
  // editor once ready. Only a 409 is benign (the wake already happened / is in
  // flight — the poll reflects it); any other failure (403, 5xx, quota) must put
  // the Resume button back with the reason, never a permanent "Resuming…" (§6.5).
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resume = useCallback(() => {
    setResuming(true);
    setResumeError(null);
    setAutoOpen(true);
    void api.startWorkspace(id).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === HTTP_CONFLICT) return;
      setResuming(false);
      setAutoOpen(false);
      setResumeError(e instanceof Error ? e.message : "resume failed");
    });
  }, [id]);
  // Arriving via the card's Resume link (autoopen) on a still-stopped workspace:
  // kick the wake exactly once.
  useEffect(() => {
    if (autoOpen && !resuming && ws?.state === "stopped") resume();
  }, [autoOpen, resuming, ws?.state, resume]);

  // Follow the log tail as new lines arrive — but only while the user is pinned
  // to the bottom. Scrolling up to read an earlier line must not be yanked back
  // down by the next poll; scrolling back to the bottom re-pins.
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const logPinnedRef = useRef(true);
  const onLogScroll = useCallback(() => {
    const el = logBoxRef.current;
    if (el === null) return;
    logPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_PIN_THRESHOLD_PX;
  }, []);
  const lineCount = logs?.lines.length ?? 0;
  useEffect(() => {
    if (logPinnedRef.current) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [lineCount]);

  if (ws === null) {
    return error !== null ? (
      <div className="notice" role="alert">
        could not load this workspace: {error}
      </div>
    ) : (
      <p className="state-note" role="status">
        loading workspace…
      </p>
    );
  }

  const ready = ws.state === "running" && ws.functional === "ok";
  const booting = ws.state === "running" && ws.functional === undefined;
  const phase = ready
    ? "Your dev desktop is ready."
    : booting
      ? "Starting your dev desktop — pulling the image and booting the editor (this can take a minute or two on first start)…"
      : ws.state === "provisioning"
        ? "Provisioning your dev desktop — starting the container (pulling the image + attaching storage). First start can take a few minutes; it opens itself once ready."
        : ws.state === "stopping"
          ? "Stopping — snapshotting your work so you can resume where you left off. Cancel to keep it running."
          : ws.state === "error"
            ? "Provisioning failed — you can retry the launch or delete this session."
            : ws.functional === "degraded"
              ? "The editor is still finishing startup — this usually clears on its own within a minute. If it persists, check the log below."
              : ws.state === "stopped"
                ? resuming
                  ? "Resuming — waking your dev desktop from its snapshot…"
                  : "Paused (snapshotted) — resume to pick up where you left off."
                : ws.state === "terminated"
                  ? "This workspace has been deleted. If it's within the restore window you can undelete it from the workspaces list."
                  : ws.state === "deleting"
                    ? "This workspace is being deleted — tearing down the task and reclaiming storage."
                    : `Workspace is ${ws.state}.`;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Poll failures AFTER data exists must stay visible (§6.5): a purged record
          (404) means this page is describing something that no longer exists, and
          any other failure means the hero below is last-known state, not live. */}
      {error !== null &&
        (errorStatus === HTTP_NOT_FOUND ? (
          <div className="notice" role="alert" data-testid="stale-banner" data-gone="1">
            this workspace no longer exists (it may have been deleted and purged) — the state below
            is its last known state. <Link href="/workspaces">back to workspaces</Link>
          </div>
        ) : (
          <div className="notice" role="status" data-testid="stale-banner">
            last refresh failed ({error}) — showing the last known state
          </div>
        ))}
      <section
        className="stack"
        style={{ gap: 12 }}
        data-testid={TESTID.workspaceStatusHero}
        data-status={ws.state}
        data-ready={ready ? "1" : "0"}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <StatusBadge state={ws.state} />
          {ws.functional === "degraded" && (
            <span className="badge" data-testid={TESTID.workspaceDegraded}>
              degraded
            </span>
          )}
          <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            {ws.imageName ?? ws.baseImage}
          </span>
        </div>
        <p style={{ fontSize: 16 }} role="status">
          {phase}
        </p>
        {ws.state === "error" && ws.functionalDetail !== undefined && (
          <p
            className="mono"
            role="alert"
            style={{ color: "var(--st-error, #ff6b6b)", fontSize: 13 }}
          >
            {ws.functionalDetail}
          </p>
        )}
        {/* The workspace's own URL — valid from the instant of creation. */}
        <code
          className="mono"
          data-testid={TESTID.workspaceUrl}
          style={{ fontSize: 12, color: "var(--dim)", wordBreak: "break-all" }}
        >
          {typeof window === "undefined"
            ? `/workspaces/${ws.id}`
            : `${window.location.origin}/workspaces/${ws.id}`}
        </code>
        {(booting || ws.state === "provisioning" || ws.state === "error") && (
          <ol
            data-testid={TESTID.workspaceSteps}
            style={{ listStyle: "none", margin: "4px 0", padding: 0, display: "grid", gap: 4 }}
          >
            {provisioningSteps(ws).map((step) => (
              <li key={step.label} className="mono" style={{ fontSize: 13 }} data-step={step.state}>
                <StepDot state={step.state} /> {step.label}
                {step.state === "active" && (
                  <span style={{ color: "var(--dim)" }}>
                    {" "}
                    — {elapsedSince(ws.lastActivity ?? ws.createdAt)} elapsed
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {(booting || ws.state === "provisioning") && (
          <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }} aria-busy="true">
            this page updates automatically — no need to reload
          </p>
        )}
        {countdown !== null && countdown > 0 && (
          <p role="status" className="mono" style={{ fontSize: 13 }}>
            opening the editor in {countdown}…{" "}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAutoOpen(false);
                setCountdown(null);
              }}
            >
              stay here
            </button>
          </p>
        )}
        {resumeError !== null && (
          <p
            className="mono"
            role="alert"
            data-testid={TESTID.workspaceResumeError}
            style={{ color: "var(--st-error, #ff6b6b)", fontSize: 13 }}
          >
            resume failed: {resumeError} — you can try again below.
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {ready && (
            <a
              className="btn primary"
              href={`/w/${ws.id}/`}
              data-testid={TESTID.workspaceOpen}
              data-href={`/w/${ws.id}/`}
            >
              Open editor
            </a>
          )}
          {ws.state === "stopped" && !resuming && (
            <button
              type="button"
              className="btn primary"
              data-testid={TESTID.workspaceResume}
              onClick={resume}
            >
              Resume
            </button>
          )}
          {/* `start` is the wake this page already drives via Resume — never a
              separate button (it would duplicate Resume). */}
          <WorkspaceActions
            id={ws.id}
            actions={ws.availableActions.filter((action) => action !== "start")}
          />
          <Link href="/workspaces" className="btn">
            all workspaces
          </Link>
        </div>
        {ws.sshCommand !== undefined && (
          <code className="mono" data-testid={TESTID.workspaceSshCommand} data-host={ws.id}>
            {ws.sshCommand}
          </code>
        )}
        {ws.repoUrl !== undefined && (
          <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            repository: {ws.repoUrl}
          </p>
        )}
      </section>

      <section>
        <h2>Boot &amp; runtime log</h2>
        <div
          className="mono"
          ref={logBoxRef}
          onScroll={onLogScroll}
          data-testid={TESTID.workspaceBootLog}
          data-available={String(logs?.available ?? false)}
          style={{
            maxHeight: 320,
            overflowY: "auto",
            fontSize: 12,
            border: "1px solid var(--line, #333)",
            borderRadius: 6,
            padding: "8px 10px",
          }}
        >
          {logs === null ? (
            <p className="state-note">loading logs…</p>
          ) : !logs.available ? (
            <p className="state-note">{logs.note}</p>
          ) : logs.lines.length === 0 ? (
            <p className="state-note">no log lines yet — the task is still coming up</p>
          ) : (
            logs.lines.map((l, i) => (
              <div key={`${l.at}-${String(i)}`} data-level={l.level}>
                <span style={{ color: "var(--dim)" }}>{new Date(l.at).toLocaleTimeString()} </span>
                <span style={{ color: l.level === "error" ? "var(--st-error)" : undefined }}>
                  {l.message}
                </span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
