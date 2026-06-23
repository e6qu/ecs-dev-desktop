// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser "control plane": orchestrates the REAL @edd/core lifecycle over localStorage,
// single-user and single-threaded (so the version-CAS/transaction concerns of the production
// WorkspaceService collapse to plain array updates). It is the demo's only mutation surface;
// React subscribes for re-render.
import {
  computeFleetCost,
  isoTimestamp,
  markDeleting,
  markProvisioned,
  markStopped,
  markWaking,
  newWorkspaceId,
  ownerId,
  provision,
  relativeWindow,
  snapshotId,
  tallyWorkspaceStates,
  taskId,
  unwrap,
  volumeId,
  workspaceActions,
  type AuditEvent,
  type BaseImage,
  type BaseImageEntry,
  type FleetCostReport,
  type IsoTimestamp,
  type SnapshotId,
  type WorkspaceCostInput,
  type Workspace,
  type WorkspaceAction,
} from "@edd/core";

import type { DemoState, DemoUser, EditorKind } from "./demo-types";
import { DEMO_PRICING, DEMO_SIZING } from "./demo-pricing";
import { clearState, loadState, saveState, stateSizeBytes } from "./persistence";
import { buildSeed } from "./seed";

export type FleetStats = ReturnType<typeof tallyWorkspaceStates>;

export class DemoControlPlane {
  private state: DemoState;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.state = loadState() ?? seedAndSave();
  }

  /** React subscribes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Monotonic snapshot for `useSyncExternalStore` (bumped on every mutation). */
  getVersion(): number {
    return this.version;
  }

  private commit(next: DemoState): void {
    this.state = next;
    this.version += 1;
    saveState(next);
    for (const l of this.listeners) l();
  }

  private now(): IsoTimestamp {
    return isoTimestamp(new Date().toISOString());
  }

  // ── reads ──
  users(): readonly DemoUser[] {
    return this.state.users;
  }
  currentUser(): DemoUser {
    const u = this.state.users.find((x) => x.id === this.state.currentUserId);
    if (u === undefined) throw new Error("current demo user missing");
    return u;
  }
  catalog(): readonly BaseImageEntry[] {
    return this.state.catalog;
  }
  audit(): readonly AuditEvent[] {
    return this.state.audit;
  }
  storageBytes(): number {
    return stateSizeBytes();
  }

  /** All workspaces, or only the current user's (the user-facing view). */
  workspaces(opts?: { mine?: boolean }): readonly Workspace[] {
    if (opts?.mine === true) {
      const me = this.state.currentUserId;
      return this.state.workspaces.filter((w) => w.ownerId === me);
    }
    return this.state.workspaces;
  }

  /** The valid actions for a workspace in its current state (drives the UI buttons). */
  actionsFor(ws: Workspace): readonly WorkspaceAction[] {
    return workspaceActions(ws.state);
  }

  // ── derived showcase data (the real @edd/core pure derivations) ──

  /** Fleet state tally (total / by-state / active) — the admin overview + infra views. */
  fleetStats(): FleetStats {
    return tallyWorkspaceStates(this.state.workspaces.map((w) => w.state));
  }

  /** Per-session/per-user spend over the real cost model + the seeded audit ledger. `windowDays`
   * scopes it (1/7/30); omitted = lifetime. The figures are computed, not hand-faked. */
  costReport(windowDays?: number): FleetCostReport {
    const now = this.now();
    const window = windowDays === undefined ? undefined : relativeWindow(now, windowDays);
    return computeFleetCost(this.costInputs(), DEMO_PRICING, DEMO_SIZING, now, window);
  }

  /** One cost input per workspace that has lifecycle events — grouping the audit ledger by
   * target and attributing each to its owner (the live record's owner, else the event actor). */
  private costInputs(): WorkspaceCostInput[] {
    const byTarget = new Map<string, AuditEvent[]>();
    for (const e of this.state.audit) {
      const list = byTarget.get(e.target) ?? [];
      list.push(e);
      byTarget.set(e.target, list);
    }
    const inputs: WorkspaceCostInput[] = [];
    for (const [workspaceId, events] of byTarget) {
      const live = this.state.workspaces.find((w) => w.id === workspaceId);
      const owner =
        (live ? this.state.users.find((u) => u.id === live.ownerId)?.email : undefined) ??
        events[0]?.actor ??
        "unknown";
      inputs.push(
        live ? { workspaceId, owner, state: live.state, events } : { workspaceId, owner, events },
      );
    }
    return inputs;
  }

  // ── identity ──
  setCurrentUser(id: string): void {
    if (this.state.users.some((u) => u.id === id)) {
      this.commit({ ...this.state, currentUserId: id });
    }
  }

  /** The editor an environment runs (defaults to the product default, OpenVSCode). */
  editorFor(workspaceId: string): EditorKind {
    return this.state.editors[workspaceId] ?? "openvscode";
  }

  // ── lifecycle (real @edd/core transitions) ──
  create(image: BaseImage, editor: EditorKind = "openvscode"): void {
    const owner = this.currentUser();
    const at = this.now();
    const id = newWorkspaceId();
    const ws = provision({
      id,
      ownerId: ownerId(owner.id),
      baseImage: image,
      volumeId: volumeId(`vol-${id}`),
      taskId: taskId(`task-${id}`),
      at,
    });
    this.commit({
      ...this.state,
      workspaces: [...this.state.workspaces, ws],
      editors: { ...this.state.editors, [id]: editor },
      audit: this.withEvent(at, owner.email, "session.create", id, `created ${image} (${editor})`),
    });
  }

  stop(id: string): void {
    this.mutate(id, (ws, at) => unwrap(markStopped(ws, { id: snapshotIdFor(ws, at), at }, at)));
  }

  start(id: string): void {
    this.mutate(id, (ws, at) =>
      unwrap(
        markProvisioned(
          unwrap(markWaking(ws, at)),
          volumeId(`vol-${id}-${String(Date.parse(at))}`),
          taskId(`task-${id}-${String(Date.parse(at))}`),
          at,
        ),
      ),
    );
  }

  remove(id: string): void {
    const at = this.now();
    const owner = this.ownerOf(id);
    const ws = this.find(id);
    unwrap(markDeleting(ws, at)); // validate the transition is legal, then hard-remove (demo)
    const editors = Object.fromEntries(
      Object.entries(this.state.editors).filter(([k]) => k !== id),
    );
    this.commit({
      ...this.state,
      workspaces: this.state.workspaces.filter((w) => w.id !== id),
      editors,
      audit: this.withEvent(at, owner.email, "session.delete", id, "workspace deleted"),
    });
  }

  /** Wipe everything (the reset widget also drops the IDE IndexedDB, then reloads). */
  reset(): void {
    clearState();
  }

  // ── internals ──
  private mutate(id: string, apply: (ws: Workspace, at: IsoTimestamp) => Workspace): void {
    const at = this.now();
    const ws = this.find(id);
    const next = apply(ws, at);
    const owner = this.ownerOf(id);
    const action = next.state === "stopped" ? "session.stop" : "session.start";
    this.commit({
      ...this.state,
      workspaces: this.state.workspaces.map((w) => (w.id === id ? next : w)),
      audit: this.withEvent(at, owner.email, action, id, next.state),
    });
  }

  private find(id: string): Workspace {
    const ws = this.state.workspaces.find((w) => w.id === id);
    if (ws === undefined) throw new Error(`workspace ${id} not found`);
    return ws;
  }

  private ownerOf(id: string): DemoUser {
    const ws = this.find(id);
    return this.state.users.find((u) => u.id === ws.ownerId) ?? this.currentUser();
  }

  private withEvent(
    at: IsoTimestamp,
    actor: string,
    action: string,
    target: string,
    detail: string,
  ): readonly AuditEvent[] {
    return [{ at, actor, action, target, detail }, ...this.state.audit];
  }
}

function seedAndSave(): DemoState {
  const s = buildSeed();
  saveState(s);
  return s;
}

function snapshotIdFor(ws: Workspace, at: IsoTimestamp): SnapshotId {
  return snapshotId(`snap-${ws.id}-${String(Date.parse(at))}`);
}
