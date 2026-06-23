// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuditEvent, BaseImageEntry, Workspace } from "@edd/core";

/** A demo-local identity (no OAuth) — drives owner attribution + the role-gated admin UI. */
export interface DemoUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "member" | "viewer";
}

/** The entire demo state, persisted as one JSON blob in localStorage. The bulky IDE
 * filesystem lives separately in IndexedDB (see the Phase-2 editor); this stays compact. */
export interface DemoState {
  readonly version: 1;
  readonly users: readonly DemoUser[];
  readonly currentUserId: string;
  readonly catalog: readonly BaseImageEntry[];
  readonly workspaces: readonly Workspace[];
  /** Append-only audit ledger — backdated at seed so cost/timeline/audit views show history. */
  readonly audit: readonly AuditEvent[];
}
