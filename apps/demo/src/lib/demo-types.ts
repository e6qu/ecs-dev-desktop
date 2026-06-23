// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuditEvent, BaseImageEntry, Workspace } from "@edd/core";

/** A demo-local identity (no OAuth) — drives owner attribution + the role-gated admin UI. */
export interface DemoUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "member" | "viewer";
}

/** The editor an environment runs. `openvscode` is the product default (the full IDE — the
 * static demo renders a VS Code-style workbench over Monaco; production runs OpenVSCode Server).
 * `monaco` is the first-party lightweight option (a real Monaco editor). */
export type EditorKind = "openvscode" | "monaco";

export const EDITOR_LABELS: Record<EditorKind, string> = {
  openvscode: "OpenVSCode",
  monaco: "Monaco",
};

/** The coding agent an environment runs (in the IDE terminal + chat panel). */
export type AgentKind = "claude-code" | "codex";

export const AGENT_LABELS: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The entire demo state, persisted as one JSON blob in localStorage. The bulky IDE
 * filesystem lives separately in IndexedDB (see the Phase-2 editor); this stays compact. */
export interface DemoState {
  readonly version: 1;
  readonly users: readonly DemoUser[];
  readonly currentUserId: string;
  readonly catalog: readonly BaseImageEntry[];
  readonly workspaces: readonly Workspace[];
  /** The editor each workspace runs (by workspace id) — the environment's editor choice. */
  readonly editors: Record<string, EditorKind>;
  /** The coding agent each workspace runs (by workspace id) — the environment's agent choice. */
  readonly agents: Record<string, AgentKind>;
  /** Append-only audit ledger — backdated at seed so cost/timeline/audit views show history. */
  readonly audit: readonly AuditEvent[];
}
