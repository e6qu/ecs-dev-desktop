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
  workspaceDegraded: "workspace-degraded",
  /** Workspace row in the admin all-workspaces table. Attrs: `data-id`, `data-status`. */
  workspaceRow: "workspace-row",
  /** Base-image card in the catalog. Attrs: `data-image`, `data-enabled`. */
  catalogCard: "catalog-card",
  /** Session environment option in the catalog picker. Attrs: `data-image`, `data-selected`, `data-tags`, `data-tools`. */
  catalogPickerOption: "catalog-picker-option",
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
  quotaUsageRow: "quota-usage-row",
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
  /** The proportional spend bar inside a per-user/per-session cost row. Attrs: `data-usd` (row total), `data-pct` (rounded integer width %). */
  costBar: "cost-bar",
  /** A time-window selector link on the admin Costs page. Attrs: `data-window`, `data-active`. */
  costWindow: "cost-window",
  /** A cluster-metric tile on the Infrastructure view. Attrs: `data-metric`, `data-value`. */
  clusterStat: "cluster-stat",
  /** A node in the Infrastructure topology graph. Attrs: `data-node`, `data-kind`, `data-h` (status). */
  topologyNode: "topology-node",
  /** An edge row in the Infrastructure topology. Attrs: `data-from`, `data-to`. */
  topologyEdge: "topology-edge",
  /** A registered SSH key row on account settings. Attrs: `data-fingerprint`. */
  sshKeyRow: "ssh-key-row",
  /** The SSH public-key textarea on account settings. */
  sshKeyInput: "ssh-key-input",
  /** Submit button to register the entered SSH key. */
  sshKeyAdd: "ssh-key-add",
  /** The per-workspace `ssh` connect command on a workspace card. Attr: `data-host`. */
  workspaceSshCommand: "workspace-ssh-command",
  /** The "Open editor" link on a workspace card (path-based `/w/<id>/` proxy). Attr: `data-href`. */
  workspaceOpen: "workspace-open",
  /** Dev-login form (EDD_DEV_AUTH=1) controls + error. */
  loginUser: "login-user",
  loginPassword: "login-password",
  loginSubmit: "login-submit",
  loginError: "login-error",
  /** The ⓘ help toggle button in the topbar. Attr: `data-help-open`. */
  helpToggle: "help-toggle",
  /** The collapsible help panel below the toolbar. */
  helpPanel: "help-panel",
} as const;

export type TestId = (typeof TESTID)[keyof typeof TESTID];
