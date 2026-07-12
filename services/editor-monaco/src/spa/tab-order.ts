// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure terminal-tab ordering + labeling helpers, split out of the DOM-heavy `main.ts` so the
// tricky bits (default label, name normalization, reorder, next-active-after-close) are unit
// testable without a browser. No DOM, no I/O — data in, data out.

/** The default (auto) label for a tab with no custom name. Keyed on the tab's stable creation
 * `id`, NOT its current position — so a tab keeps its label when reordered, and closing a tab
 * never renumbers the others (the old `Terminal ${tabs.length + 1}` scheme produced duplicate
 * labels after a close-then-open). */
export function defaultTabLabel(id: number): string {
  return `Terminal ${String(id)}`;
}

/** Normalize a user-entered tab name: trimmed; an empty result means "no custom name" (revert
 * to the {@link defaultTabLabel}). Returned `null` is the canonical "no name" state. */
export function normalizeTabName(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The label to show for a tab: its custom name when set, else the id-based default. */
export function displayTabLabel(name: string | null, id: number): string {
  return name ?? defaultTabLabel(id);
}

/** Move the element at `from` to `to`, returning a NEW array (out-of-range indices are a no-op
 * that returns a copy). Used by both drag-and-drop and the keyboard move. */
export function moveInArray<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = [...arr];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

/**
 * Which tab id becomes active after `closingId` is removed from `order`. Mirrors a real editor:
 * when the active tab closes, focus the tab that slides into its slot (the next one), or the
 * previous one if it was last; closing a non-active tab leaves the active unchanged. Returns
 * `null` when nothing remains (the panel then hides). `order` is the ids in tab-bar order.
 */
export function nextActiveAfterClose(
  order: readonly number[],
  closingId: number,
  currentActive: number | null,
): number | null {
  const index = order.indexOf(closingId);
  if (index === -1) return currentActive;
  const remaining = order.filter((id) => id !== closingId);
  if (remaining.length === 0) return null;
  if (currentActive !== closingId) return currentActive;
  // Prefer the tab that took the closed slot (same index), else the new last one.
  return remaining[index] ?? remaining[remaining.length - 1] ?? null;
}
