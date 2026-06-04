// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A typed success-or-failure value — errors as data, not exceptions. Domain
 * operations return `Result<T, E>` so the compiler forces every caller to handle
 * the failure (you cannot read `.value` without first narrowing on `.ok`). This
 * is the project's alternative to `throw` + `try/catch` + `instanceof` ladders:
 * a forgotten error case becomes a type error, not a runtime mis-handling.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Transform the success value, leaving an error untouched. */
export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/** Transform the error, leaving a success untouched. */
export function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

/** Chain a fallible step that runs only on success (short-circuits on error). */
export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}
