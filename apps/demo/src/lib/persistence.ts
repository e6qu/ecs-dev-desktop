// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DemoState } from "./demo-types";

// Everything the demo persists lives under ONE namespaced key, so reset is a single removal
// and the budget is easy to measure. The branded domain types serialize as their string
// values (plain JSON), so a round-trip restores usable @edd/core objects.
const STORAGE_KEY = "edd-demo:state:v1";

export function loadState(): DemoState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // A shallow shape check — a corrupt/old blob is discarded (re-seeds) rather than crashing.
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      return parsed as DemoState;
    }
    return null;
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
