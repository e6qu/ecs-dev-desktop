// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Entity } from "electrodb";

import { TABLE } from "./index";

/**
 * ElectroDB Workspace entity over the single table. ElectroDB owns the concrete
 * key formatting; the index `field` names match the table's PK/SK/GSI columns
 * (see `table.ts`).
 */
export function makeWorkspaceEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "workspace", version: "1", service: "edd" },
      attributes: {
        id: { type: "string", required: true },
        ownerId: { type: "string", required: true },
        baseImage: { type: "string", required: true },
        state: {
          type: ["provisioning", "running", "idle", "stopped", "terminated", "error"] as const,
          required: true,
        },
        lastActivity: { type: "string", required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["id"] },
          sk: { field: "SK", composite: [] },
        },
        byOwner: {
          index: "GSI1",
          pk: { field: "GSI1PK", composite: ["ownerId"] },
          sk: { field: "GSI1SK", composite: ["createdAt"] },
        },
        byState: {
          index: "GSI2",
          pk: { field: "GSI2PK", composite: ["state"] },
          sk: { field: "GSI2SK", composite: ["lastActivity"] },
        },
      },
    },
    { client, table },
  );
}

export type WorkspaceEntity = ReturnType<typeof makeWorkspaceEntity>;
