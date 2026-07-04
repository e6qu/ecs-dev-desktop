// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Walk the error cause chain for DynamoDB's conditional-write failure.
 * ElectroDB surfaces it as `ConditionalCheckFailedException` or a message
 * containing "conditional request failed" (SDK v3 wraps it in the cause chain).
 */
export function isVersionConflict(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
    if (e.name === "ConditionalCheckFailedException") return true;
    if (/conditional request failed/i.test(e.message)) return true;
  }
  return false;
}
