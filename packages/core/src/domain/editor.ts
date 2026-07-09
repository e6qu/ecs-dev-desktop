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
 *  - `terminal` — the first-party multi-tab terminal server. The image ships
 *    both `claude` and `codex` CLIs for users to run from the shell.
 *  - `opencode` — opencode's local browser client, backed by the in-workspace
 *    `opencode web` process (not an EDD-reimplemented chat UI).
 */
export const EDITOR_KINDS = ["openvscode", "monaco", "terminal", "opencode"] as const;

export type EditorKind = (typeof EDITOR_KINDS)[number];

/** The default editor when none is specified. */
export const DEFAULT_EDITOR: EditorKind = "openvscode";

function describeUnknownEditor(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (value === null) return "null";
  if (typeof value === "symbol") return value.description ?? "symbol";
  return `type ${typeof value}`;
}

/** Narrow an arbitrary value to an `EditorKind`; unknown values are invalid persisted state. */
export function asEditorKind(value: unknown): EditorKind {
  if (value === undefined) return DEFAULT_EDITOR;
  const editor = EDITOR_KINDS.find((k) => k === value);
  if (editor === undefined) throw new Error(`unknown editor kind: ${describeUnknownEditor(value)}`);
  return editor;
}
