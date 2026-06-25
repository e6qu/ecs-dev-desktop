// SPDX-License-Identifier: AGPL-3.0-or-later

/** USD formatter (matches the production costs page). A non-finite value renders as `$0.00` rather
 * than a literal `$NaN`/`$∞` leaking into the costs UI (consistent with {@link pct}'s guard). */
export function usd(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

/** A value's percent of a list max, clamped to [0,100]; maxUsd<=0 or a non-finite value → 0 (no
 * divide-by-zero, and never a NaN/Infinity that would render as `width: NaN%`). */
export function pct(value: number, maxUsd: number): number {
  if (maxUsd <= 0 || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, (value / maxUsd) * 100));
}

/** Compact relative time, e.g. "3d ago" / "5h ago" / "just now". */
export function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${String(days)}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${String(hours)}h ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins > 0) return `${String(mins)}m ago`;
  return "just now";
}
