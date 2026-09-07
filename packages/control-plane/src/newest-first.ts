// SPDX-License-Identifier: AGPL-3.0-or-later
/** Records ordered newest first by their ISO `createdAt` (a lexical compare is a
 * chronological one for ISO-8601 UTC timestamps). Returns a new array. */
export function newestFirst<T extends { readonly createdAt: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}
