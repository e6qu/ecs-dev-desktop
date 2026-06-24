// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which editor a workspace serves. `openvscode` is OpenVSCode Server (the full IDE baked into the
 * golden image, the historical default). `monaco` is the first-party lightweight editor served by
 * the in-container Monaco editor server. The choice flows base-image → workspace →
 * `EDD_EDITOR_MODE` env, which the container entrypoint branches on to launch the right server.
 */
export const EDITOR_KINDS = ["openvscode", "monaco"] as const;

export type EditorKind = (typeof EDITOR_KINDS)[number];

/** The default editor when none is specified (records/requests predating the field). */
export const DEFAULT_EDITOR: EditorKind = "openvscode";

/** Narrow an arbitrary value to an `EditorKind`, falling back to the default for unknown input. */
export function asEditorKind(value: unknown): EditorKind {
  return EDITOR_KINDS.find((k) => k === value) ?? DEFAULT_EDITOR;
}
