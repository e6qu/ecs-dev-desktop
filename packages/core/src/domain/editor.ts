// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which primary interface a workspace serves. The choice flows base-image (or a
 * per-session override at create) → workspace → `EDD_EDITOR_MODE` env, which the
 * container entrypoint branches on to launch the right server:
 *
 *  - `openvscode` — OpenVSCode Server, the full IDE baked into the golden image
 *    (the historical default).
 *  - `monaco` — the first-party lightweight editor served by the in-container
 *    Monaco editor server.
 *  - `claude` / `codex` — agent-first sessions: the same Monaco editor server,
 *    but every terminal boots straight into the Claude Code / Codex CLI instead
 *    of a shell. Neither CLI ships a self-hostable web UI (their "web apps" are
 *    hosted-only products serving from the vendor's own domain), so the
 *    CLI-as-the-app terminal is the faithful self-hosted equivalent.
 */
export const EDITOR_KINDS = ["openvscode", "monaco", "claude", "codex"] as const;

export type EditorKind = (typeof EDITOR_KINDS)[number];

/** The default editor when none is specified (records/requests predating the field). */
export const DEFAULT_EDITOR: EditorKind = "openvscode";

/** Narrow an arbitrary value to an `EditorKind`, falling back to the default for unknown input. */
export function asEditorKind(value: unknown): EditorKind {
  return EDITOR_KINDS.find((k) => k === value) ?? DEFAULT_EDITOR;
}
