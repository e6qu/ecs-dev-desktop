// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser "control plane": orchestrates the REAL @edd/core lifecycle over localStorage,
// single-user and single-threaded (so the version-CAS/transaction concerns of the production
// WorkspaceService collapse to plain array updates). It is the demo's only mutation surface;
// React subscribes for re-render.
import { defineAbilityFor } from "@edd/authz";
import {
  computeFleetCost,
  deriveWorkspaceTimeline,
  isoTimestamp,
  markDeleting,
  markProvisioned,
  markStopped,
  markWaking,
  newWorkspaceId,
  overlayTopologyHealth,
  ownerId,
  provision,
  relativeWindow,
  snapshotId,
  sshKeyType,
  summarizeHealth,
  SYSTEM_TOPOLOGY,
  tallyWorkspaceStates,
  taskId,
  unwrap,
  volumeId,
  workspaceActions,
  type AuditEvent,
  type BaseImage,
  type BaseImageEntry,
  type ComponentHealth,
  type FleetCostReport,
  type HealthReport,
  type IsoTimestamp,
  type SessionCost,
  type SnapshotId,
  type TimelineEvent,
  type TopologyNodeStatus,
  type WorkspaceCostInput,
  type Workspace,
  type WorkspaceAction,
} from "@edd/core";

import type { AgentKind, DemoState, DemoUser, EditorKind, SshKeyEntry } from "./demo-types";
import { DEMO_PRICING, DEMO_SIZING } from "./demo-pricing";
import { clearState, loadState, saveState, stateSizeBytes } from "./persistence";
import { buildSeed } from "./seed";

export type FleetStats = ReturnType<typeof tallyWorkspaceStates>;

/** How long a freshly-created demo workspace shows `provisioning` before advancing to `running`
 * (a visible cold-start, not so long it feels stuck). */
const PROVISIONING_DWELL_MS = 1500;

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

  /** Whether the acting identity may create/stop/delete workspaces — the REAL CASL ability
   * (`@edd/authz`), so the identity switcher tells a true RBAC story: a viewer is read-only. */
  canMutateWorkspaces(): boolean {
    const u = this.currentUser();
    return defineAbilityFor({ id: ownerId(u.id), role: u.role }).can("create", "Workspace");
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

  /** Component health for the admin Health board — partly DERIVED from fleet state (e.g. a
   * workspace in `error` degrades compute) so it tracks what the demo is actually doing. */
  healthComponents(): ComponentHealth[] {
    const anyError = this.state.workspaces.some((w) => w.state === "error");
    return [
      { component: "control-plane", status: "ok", detail: "web + API responding" },
      { component: "reconciler", status: "ok", detail: "idle sweep ran recently" },
      {
        component: "compute",
        status: anyError ? "degraded" : "ok",
        detail: anyError ? "a workspace task is in error" : "ECS Fargate healthy",
      },
      { component: "storage", status: "ok", detail: "EBS volumes + snapshots healthy" },
    ];
  }

  /** Overall health roll-up (the real `summarizeHealth`). */
  healthReport(): HealthReport {
    return summarizeHealth(this.healthComponents(), this.now());
  }

  /** The system topology with health overlaid (the real `overlayTopologyHealth`). */
  topology(): TopologyNodeStatus[] {
    return overlayTopologyHealth(SYSTEM_TOPOLOGY, this.healthComponents());
  }

  /** Cluster summary for the Infrastructure view (derived from fleet state). */
  clusterInfo(): { name: string; status: string; running: number; pending: number } {
    const running = this.state.workspaces.filter(
      (w) => w.state === "running" || w.state === "idle",
    ).length;
    const pending = this.state.workspaces.filter((w) => w.state === "provisioning").length;
    return { name: "edd-demo (local)", status: "ACTIVE", running, pending };
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

  /** The coding agent an environment runs (defaults to Claude Code). */
  agentFor(workspaceId: string): AgentKind {
    return this.state.agents[workspaceId] ?? "claude-code";
  }

  /** A single workspace by id (for the detail view). */
  workspaceById(workspaceId: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === workspaceId);
  }

  /** A workspace's lifecycle timeline (the real `deriveWorkspaceTimeline`, oldest-first). */
  timelineFor(workspaceId: string): TimelineEvent[] {
    const ws = this.workspaceById(workspaceId);
    if (ws === undefined) return [];
    return deriveWorkspaceTimeline({
      createdAt: ws.createdAt,
      lastActivity: ws.lastActivity,
      ...(ws.latestSnapshotAt !== undefined ? { latestSnapshotAt: ws.latestSnapshotAt } : {}),
    });
  }

  /** The audit ledger filtered to one workspace (newest-first, as stored). */
  auditFor(workspaceId: string): AuditEvent[] {
    return this.state.audit.filter((e) => e.target === workspaceId);
  }

  /** The real per-session cost for one workspace (lifetime), if it has billable history. */
  sessionCostFor(workspaceId: string): SessionCost | undefined {
    return this.costReport().bySession.find((s) => s.workspaceId === workspaceId);
  }

  // ── lifecycle (real @edd/core transitions) ──
  create(
    image: BaseImage,
    editor: EditorKind = "openvscode",
    agent: AgentKind = "claude-code",
  ): void {
    const owner = this.currentUser();
    const at = this.now();
    const id = newWorkspaceId();
    // A new workspace cold-starts: it provisions (hydrates from a base image) BEFORE it's running
    // — the platform's signature scale-to-zero/wake behaviour — then advances to running after a
    // short dwell, so the demo shows the provisioning pulse instead of an instant jump to running.
    const running = provision({
      id,
      ownerId: ownerId(owner.id),
      baseImage: image,
      volumeId: volumeId(`vol-${id}`),
      taskId: taskId(`task-${id}`),
      at,
    });
    const ws: Workspace = { ...running, state: "provisioning" };
    this.commit({
      ...this.state,
      workspaces: [...this.state.workspaces, ws],
      editors: { ...this.state.editors, [id]: editor },
      agents: { ...this.state.agents, [id]: agent },
      audit: this.withEvent(
        at,
        owner.email,
        "session.create",
        id,
        `created ${image} (${editor}/${agent})`,
      ),
    });
    this.scheduleProvisioned(id);
  }

  /** After a short dwell, advance a freshly-created workspace provisioning → running (the real
   * state-machine transition). Fire-and-forget: re-reads current state and no-ops if the workspace
   * was deleted or already moved on (and a page reload after reset drops any pending timer). */
  private scheduleProvisioned(id: string): void {
    setTimeout(() => {
      const ws = this.state.workspaces.find((w) => w.id === id);
      if (ws?.state !== "provisioning") return; // deleted or already advanced — no-op
      const at = this.now();
      const provisioned = unwrap(
        markProvisioned(
          ws,
          volumeId(`vol-${id}-${String(Date.parse(at))}`),
          taskId(`task-${id}-${String(Date.parse(at))}`),
          at,
        ),
      );
      this.commit({
        ...this.state,
        workspaces: this.state.workspaces.map((w) => (w.id === id ? provisioned : w)),
        audit: this.withEvent(
          at,
          this.ownerOf(id).email,
          "session.ready",
          id,
          "provisioned — now running",
        ),
      });
    }, PROVISIONING_DWELL_MS);
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
    const agents = Object.fromEntries(Object.entries(this.state.agents).filter(([k]) => k !== id));
    this.commit({
      ...this.state,
      workspaces: this.state.workspaces.filter((w) => w.id !== id),
      editors,
      agents,
      audit: this.withEvent(at, owner.email, "session.delete", id, "workspace deleted"),
    });
  }

  /** Wipe everything (the reset widget also drops the IDE IndexedDB, then reloads). */
  reset(): void {
    clearState();
  }

  // ── SSH keys (account settings) ──
  /** The current user's registered SSH keys, newest-first. */
  sshKeys(): SshKeyEntry[] {
    const uid = this.state.currentUserId;
    return this.state.sshKeys
      .filter((k) => k.ownerId === uid)
      .slice()
      .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  }

  /** Register a public key for the current user. The type is validated by the real @edd/core
   * `sshKeyType` (it throws on a key with no type field — the page surfaces the message). */
  addSshKey(publicKey: string, label: string): void {
    const trimmed = publicKey.trim();
    const keyType = sshKeyType(trimmed);
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2 || (parts[1] ?? "").length < 8) {
      throw new Error("ssh public key is missing its key data");
    }
    const owner = this.currentUser();
    const at = this.now();
    const entry: SshKeyEntry = {
      id: `key-${crypto.randomUUID()}`,
      ownerId: owner.id,
      label: label.trim() === "" ? keyType : label.trim(),
      keyType,
      publicKey: trimmed,
      addedAt: at,
    };
    this.commit({
      ...this.state,
      sshKeys: [...this.state.sshKeys, entry],
      audit: this.withEvent(at, owner.email, "sshkey.add", entry.id, `registered ${keyType} key`),
    });
  }

  /** Remove one of the current user's SSH keys. */
  removeSshKey(id: string): void {
    const owner = this.currentUser();
    const at = this.now();
    this.commit({
      ...this.state,
      sshKeys: this.state.sshKeys.filter((k) => k.id !== id),
      audit: this.withEvent(at, owner.email, "sshkey.remove", id, "removed SSH key"),
    });
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
