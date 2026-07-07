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
 *  - `claude` — Claude Code, using Anthropic's own Remote Control/web harness
 *    against the local workspace process (not an EDD-reimplemented chat UI).
 *  - `codex` — Codex, using OpenAI's own local app-server/client harness (not an
 *    EDD-reimplemented chat UI).
 */
export const EDITOR_KINDS = ["openvscode", "monaco", "claude", "codex"] as const;

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
