// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stable, typed selectors shared by the components that render them and the
 * Playwright tests that find them. The contract: **locate** an element by its
 * `data-testid` (never by rendered text, which is copy-dependent and flaky) and
 * **assert** dynamic values via the typed `data-*` attributes listed beside each
 * id. Because both sides import this one const, renaming or removing an id is a
 * compile error in the component and the test at once.
 */
export const TESTID = {
  /** Workspace card on the portal grid. Attrs: `data-image`, `data-status` (state). */
  workspaceCard: "workspace-card",
  /** Workspace row in the admin all-workspaces table. Attrs: `data-id`, `data-status`. */
  workspaceRow: "workspace-row",
  /** Base-image card in the catalog. Attrs: `data-image`, `data-enabled`. */
  catalogCard: "catalog-card",
  /** Dependency row in the Health board. Attrs: `data-component`, `data-h` (status). */
  healthRow: "health-row",
  /** Stat tile on the admin Overview. Attrs: `data-stat`, `data-value`. */
  statTile: "stat-tile",
  /** Row on a workspace's derived lifecycle timeline. Attrs: `data-event`. */
  timelineRow: "timeline-row",
  /** Row in the derived audit feed. Attrs: `data-action`. */
  auditRow: "audit-row",
  /** A log-stream panel on the Logs screen. Attrs: `data-stream`, `data-available`. */
  logStream: "log-stream",
  /** A per-role limit row on the Quotas page. Attrs: `data-role`. */
  quotaRow: "quota-row",
  /** The "admins only" gate shown to non-admins. */
  adminDenied: "admin-denied",
  /** A repo row in the New-session repo browser. Attrs: `data-repo`, `data-private`. */
  sessionRepoRow: "session-repo-row",
  /** "Start session" button on a repo row / panel. */
  startSession: "start-session",
  /** The create-repository panel on New session. Attr: `data-enabled`. */
  createRepoPanel: "create-repo-panel",
  /** Start a blank/scratch session (no repo). */
  blankSession: "blank-session",
  /** A fleet-total cost tile on the admin Costs page. Attrs: `data-cost` (kind), `data-usd`. */
  costTile: "cost-tile",
  /** A per-user cost row on the admin Costs page. Attrs: `data-owner`, `data-usd`. */
  costUserRow: "cost-user-row",
  /** A per-session cost row on the admin Costs page. Attrs: `data-id`, `data-owner`, `data-usd`. */
  costSessionRow: "cost-session-row",
} as const;

export type TestId = (typeof TESTID)[keyof typeof TESTID];
