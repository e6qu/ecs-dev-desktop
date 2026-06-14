// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal } from "@edd/authz";
import type { AuditAction } from "@edd/control-plane";

import { getAuditLog } from "./control-plane";
import { errorField, log } from "./logger";

/** The actor string recorded for a principal — email when known (stable across
 * IdPs), else the user id. */
export function auditActor(principal: Principal): string {
  return principal.email ?? principal.id;
}

/**
 * Append a control-plane action to the first-class audit log. Best-effort: an
 * audit-store failure must NOT fail the user's action, but it is logged loudly
 * (never silently swallowed — see AGENTS.md §6.5).
 */
export async function recordAudit(event: AuditAction): Promise<void> {
  try {
    await getAuditLog().record(event);
  } catch (err) {
    log.error("failed to record audit event", { action: event.action, error: errorField(err) });
  }
}
