// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Domain failures as data (returned in a `Result`, never thrown). The `kind`
 * discriminant is a *domain* classification — deliberately transport-agnostic:
 * the HTTP-status mapping lives in the web shell, keyed on `kind`, so adding a
 * kind here forces every mapper to handle it (a compile error otherwise).
 */
export type DomainErrorKind = "not_found" | "conflict" | "invalid";

export type DomainError =
  | { readonly kind: "not_found"; readonly resource: string; readonly id: string }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** A resource (by id) does not exist → 404 at the HTTP boundary. */
export const notFoundError = (resource: string, id: string): DomainError => ({
  kind: "not_found",
  resource,
  id,
});

/** The operation conflicts with the resource's current state → 409. */
export const conflictError = (reason: string): DomainError => ({ kind: "conflict", reason });

/** The request is well-formed but not valid for the domain → 400. */
export const invalidError = (reason: string): DomainError => ({ kind: "invalid", reason });

/** A human-readable message for a domain error (for API bodies, logs). */
export function domainErrorMessage(error: DomainError): string {
  switch (error.kind) {
    case "not_found":
      return `${error.resource} not found: ${error.id}`;
    case "conflict":
    case "invalid":
      return error.reason;
  }
}
