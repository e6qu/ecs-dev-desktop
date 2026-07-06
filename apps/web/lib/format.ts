// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-safe formatting helpers. Deliberately NOT a "use client" module so both
// server components (WorkspaceCard) and client components (WorkspaceInfo,
// WorkspaceMonitoring) can call these during render — a plain function exported
// from a "use client" module becomes a client reference and throws when a server
// component calls it ("Attempted to call gib() from the server").

const BYTES_PER_GIB = 1024 ** 3;

/** Bytes → a short human GiB figure (one decimal). */
export function gib(bytes: number): string {
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
}
