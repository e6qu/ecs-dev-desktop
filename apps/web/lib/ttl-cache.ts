// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A single-value, time-to-live memo over an async loader. Within `ttlMs` of the
 * last load, callers share the cached result (and an in-flight load is shared, so
 * a burst of concurrent callers triggers exactly one `load`). After the TTL — or
 * if the load rejects — the next call reloads. Time is passed in (`nowMs`) so the
 * behaviour is deterministic and testable; production callers default it to now.
 */
export interface TtlCache<T> {
  (nowMs: number): Promise<T>;
  /** Drop the cached value so the next call reloads — for a writer in this process that
   * knows the underlying data changed (a read right after a write must see the write). */
  invalidate(): void;
}

export function ttlCache<T>(load: () => Promise<T>, ttlMs: number): TtlCache<T> {
  let entry: { readonly at: number; readonly value: Promise<T> } | undefined;
  const read = (nowMs: number): Promise<T> => {
    if (entry !== undefined && nowMs - entry.at < ttlMs) return entry.value;
    const value = load();
    const current = { at: nowMs, value };
    entry = current;
    // A rejected load must not be cached for the whole TTL — drop it so the next
    // call retries. This does not swallow the error: `value` still rejects.
    void value.catch(() => {
      if (entry === current) entry = undefined;
    });
    return value;
  };
  read.invalidate = () => {
    entry = undefined;
  };
  return read;
}
