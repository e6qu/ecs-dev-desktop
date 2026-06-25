// SPDX-License-Identifier: AGPL-3.0-or-later
import { STATE_VERSION, type DemoState } from "./demo-types";

// Everything the demo persists lives under ONE namespaced key, so reset is a single removal
// and the budget is easy to measure. The branded domain types serialize as their string
// values (plain JSON), so a round-trip restores usable @edd/core objects.
const STORAGE_KEY = "edd-demo:state:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Accept ONLY a blob of the current version AND the current top-level shape — so a torn write or a
 * hand-edited blob with the right `version` but a missing/retyped collection is re-seeded rather
 * than read into newer code (where an absent collection then crashes on first access). §6.5a. */
function isDemoState(value: unknown): value is DemoState {
  if (!isRecord(value) || value.version !== STATE_VERSION) return false;
  const arraysOk = (["users", "catalog", "workspaces", "sshKeys", "audit"] as const).every((k) =>
    Array.isArray(value[k]),
  );
  const recordsOk = (["editors", "agents"] as const).every(
    (k) => isRecord(value[k]) && !Array.isArray(value[k]),
  );
  return typeof value.currentUserId === "string" && arraysOk && recordsOk;
}

export function loadState(): DemoState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDemoState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveState(state: DemoState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Clear the demo's localStorage namespace (the reset widget also drops the IDE IndexedDB). */
export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Bytes the persisted state currently occupies — surfaced in the demo's storage-budget note. */
export function stateSizeBytes(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? 0 : new Blob([raw]).size;
}
