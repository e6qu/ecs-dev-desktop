// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Nominal/branded types. `Brand<string, "X">` is structurally a string at
 * runtime but a distinct type at compile time, so a `VolumeId` cannot be passed
 * where a `SnapshotId` is expected. Branding is the one place a type assertion
 * is unavoidable (a runtime string *is* the branded value); it is isolated here
 * and in the per-type smart constructors (see `ids.ts`).
 */
declare const brandTag: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandTag]: B };

/** Internal branding primitive — the single, intentional assertion site. */
export function brand<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}
