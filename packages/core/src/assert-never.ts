// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Compile-time exhaustiveness guard. Call it in the `default` of a `switch` over
 * a union: if every case is handled, `x` narrows to `never` and this type-checks;
 * add a variant to the union and the call stops compiling until it is handled.
 * The runtime throw only fires if an unexpected value slips past the types.
 */
export function assertNever(x: never): never {
  throw new Error(`unreachable: unexpected value ${JSON.stringify(x)}`);
}
