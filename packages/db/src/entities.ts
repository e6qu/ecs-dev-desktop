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
        // Runtime bindings (absent while stopped/scaled-to-zero).
        volumeId: { type: "string", required: false },
        taskId: { type: "string", required: false },
        latestSnapshotId: { type: "string", required: false },
        // When the latest snapshot was taken (drives scheduled-snapshot timing).
        latestSnapshotAt: { type: "string", required: false },
        // Private IP of the running task's ENI; absent when stopped/scaled-to-zero.
        sshHost: { type: "string", required: false },
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

/**
 * ElectroDB Base-image catalog entity over the same single table. `byCatalog`
 * lists every entry from one static partition (the catalog is small); it reuses
 * GSI1, scoped from the workspace entity by ElectroDB's per-entity key prefix.
 */
export function makeBaseImageEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "baseImage", version: "1", service: "edd" },
      attributes: {
        id: { type: "string", required: true },
        name: { type: "string", required: true },
        image: { type: "string", required: true },
        description: { type: "string", required: true },
        enabled: { type: "boolean", required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["id"] },
          sk: { field: "SK", composite: [] },
        },
        byCatalog: {
          index: "GSI1",
          pk: { field: "GSI1PK", composite: [] },
          sk: { field: "GSI1SK", composite: ["createdAt", "id"] },
        },
      },
    },
    { client, table },
  );
}

export type BaseImageEntity = ReturnType<typeof makeBaseImageEntity>;
