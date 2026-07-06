// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Domain constants. No magic literals elsewhere in the core — values with
 * meaning are named and documented here.
 */

/** Prefixes that make ids self-describing in logs and the data store. */
export const ID_PREFIX = {
  workspace: "ws-",
  volume: "vol-",
  snapshot: "snap-",
  task: "task-",
  baseImage: "img-",
  sshKey: "sshk-",
} as const;

/** Default cooldown after a workspace stops being loaded (no open tab, no SSH,
 * no activity) before scale-to-zero: 5 minutes (product decision, 2026-07-06 —
 * an open BACKGROUND tab counts as loaded via the proxy presence sweep, capped
 * by the auth session's 4-h validity, so this only starts once truly unloaded). */
export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** Grace window after a MANUAL stop is requested before the session is actually
 * torn down — the user's chance to cancel and resume. Short (seconds), since the
 * point is a brief "oops, keep it" window, not a long delay. */
export const DEFAULT_STOP_GRACE_MS = 6 * 1000;

/** How long a deleted (terminated) workspace stays restorable before its
 * tombstone + retained snapshot are purged: 7 days (product decision, 2026-07-06). */
export const DEFAULT_UNDELETE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default interval between scheduled point-in-time snapshots: 6 hours. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Shorter snapshot cadence for a YOUNG workspace (created within
 * {@link DEFAULT_EARLY_SESSION_MS}): 10 minutes. A fresh session's work is the most
 * exposed — a never-snapshotted workspace is captured on the very next sweep, but
 * without this its *second* snapshot would wait the full 6h. The early cadence keeps
 * a new session's data recoverable to within ~10 minutes before it settles onto the
 * steady-state interval, bounding data loss on an early Fargate eviction/crash.
 */
export const DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** How long a workspace counts as "early session" for the shorter snapshot cadence: 1 hour. */
export const DEFAULT_EARLY_SESSION_MS = 60 * 60 * 1000;

/** Newest ACTIVE task-definition revisions to keep per workspace family when the
 * reconciler prunes (older ones are deregistered). Per-launch secret injection forces
 * a new revision each time, so they accumulate unbounded; keeping a generous recent
 * window bounds them while leaving plenty for in-flight launches. */
export const DEFAULT_TASKDEF_KEEP_REVISIONS = 20;

/** Max finish-delete / error-recover convergence actions the reconciler performs per
 * sweep. Bounds blast radius after a mass drift/delete event — the fleet converges
 * over several sweeps instead of issuing thousands of stop/delete calls at once. */
export const DEFAULT_CONVERGE_BUDGET = 50;

/**
 * How long a workspace may sit in `provisioning` before the reconciler treats the
 * wake as dead and reverts it to `stopped` (self-healing): 10 minutes. A legitimate
 * cold start resolves well inside this — the readiness poll caps PHASE 2 at ~180s and
 * the in-process `start()` then commits running or rolls back — so only a wake whose
 * driving process *crashed* between the claim and the commit stays provisioning this
 * long. Comfortably above the legit window so an in-flight wake is never reverted.
 */
export const DEFAULT_PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Grace window before an unreferenced volume/snapshot becomes GC-eligible: 1
 * hour. Guards against reaping a resource that was just created but is not yet
 * recorded against a workspace in the control plane (a create/persist race).
 */
export const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;

/** Default number of most-recent events the admin audit feed returns. */
export const DEFAULT_AUDIT_FEED_LIMIT = 100;

/**
 * How long since the reconciler's last successful sweep before the Health board
 * reports it `degraded`: 15 minutes (3× the default `rate(5 minutes)` schedule, so
 * a single missed run is tolerated but a stalled loop is surfaced).
 */
export const DEFAULT_RECONCILER_STALE_MS = 15 * 60 * 1000;

/**
 * Default heartbeat interval injected into workspace tasks: 5 minutes. The
 * in-workspace idle-agent posts an HMAC heartbeat to the control plane at this
 * cadence; the `lastActivity` timestamp it updates is what the reconciler's
 * idle-detection reads. Short enough that idle-to-zero is responsive (within
 * `threshold + one heartbeat`), long enough to avoid excessive control-plane
 * load at 200+ scale.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 5 * 60;
