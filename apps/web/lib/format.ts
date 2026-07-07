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

/** Compact "how long ago" from `fromMs` to `nowMs` (minute resolution and up).
 * Both instants are passed in so the result is deterministic (no hidden clock). */
export function humanAgo(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ${String(mins % 60)}m ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ${String(hours % 24)}h ago`;
}

/** Format an epoch-ms instant as a compact UTC stamp: `2026-07-06 17:12 UTC`. */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear())}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} UTC`;
}

/** Human byte size that picks the unit (B / KiB / MiB / GiB) — for image + layer sizes. */
export function humanBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? String(n) : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
