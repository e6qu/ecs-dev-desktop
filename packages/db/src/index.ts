// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@edd/db` — the DynamoDB single-table persistence layer. ElectroDB
 * (`entities.ts`) owns the concrete key formatting; the table schema lives in
 * `table.ts`. No hand-rolled key strings (that duplicated ElectroDB).
 */

import { DEFAULT_DYNAMODB_TABLE, dynamodb } from "@edd/config";

/** Default single-table name (from the typed config). */
export const TABLE = DEFAULT_DYNAMODB_TABLE;

/** DynamoDB Local connection config (Tier-2 harness / integration tests). */
export { dynamodb };

export { createDynamoClient } from "./client";
export { pingTable } from "./health";
/** ElectroDB cross-entity write transaction (single-table → atomic). Used to
 * commit a lifecycle state transition and its audit event together, so a
 * billable event can never be lost relative to the transition it records. */
export { createWriteTransaction as writeTransaction } from "electrodb";
export { dropTable, ensureTable, tableDefinition } from "./table";
export { waitForDynamo } from "./wait";
export {
  makeAuditEventEntity,
  makeBaseImageEntity,
  makeGitCredentialEntity,
  makeWorkspaceEntity,
  type AuditEventEntity,
  type BaseImageEntity,
  type GitCredentialEntity,
  type WorkspaceEntity,
} from "./entities";
