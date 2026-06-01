// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DynamoDB single-table key design. ElectroDB entities (wired once DynamoDB
 * Local is added to the Tier-2 harness) will build on these access patterns:
 *
 *   PK / SK            — item identity
 *   GSI1 (byOwner)     — list a user's workspaces
 *   GSI2 (byStateAt)   — reconciler scan: workspaces in a state, oldest-activity first
 *
 * Keys are pure functions so they are unit-testable without a database.
 */
export const TABLE = "ecs-dev-desktop";

export const keys = {
  workspace: (id: string) => ({ PK: `WORKSPACE#${id}`, SK: `WORKSPACE#${id}` }),
  snapshot: (workspaceId: string, snapshotId: string) => ({
    PK: `WORKSPACE#${workspaceId}`,
    SK: `SNAPSHOT#${snapshotId}`,
  }),
  byOwner: (ownerId: string) => ({ GSI1PK: `USER#${ownerId}`, GSI1SK: "WORKSPACE#" }),
  byStateActivity: (state: string, lastActivityIso: string) => ({
    GSI2PK: `STATE#${state}`,
    GSI2SK: `ACTIVITY#${lastActivityIso}`,
  }),
} as const;
