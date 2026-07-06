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
        // Owner's email — the identity the proxy matches a caller against for
        // per-workspace access. Optional: records predating the field have none.
        ownerEmail: { type: "string", required: false },
        // Owner's role at create time — lets the admin quota view flag a workspace against its
        // owner's per-role limit. Optional: records predating the field have none.
        ownerRole: { type: ["viewer", "member", "admin"] as const, required: false },
        // Git repo cloned into the session at first boot ("one repo per
        // session"). Optional: blank/scratch sessions have none.
        repoUrl: { type: "string", required: false },
        baseImage: { type: "string", required: true },
        // Which editor this workspace serves (drives EDD_EDITOR_MODE). Optional: records
        // predating the field are treated as the default (OpenVSCode).
        editor: { type: ["openvscode", "monaco", "claude", "codex"] as const, required: false },
        state: {
          type: [
            "provisioning",
            "running",
            "idle",
            "stopped",
            "deleting",
            "terminated",
            "error",
          ] as const,
          required: true,
        },
        // Durable convergence intent: whether this workspace should exist
        // (`present`) or be torn down (`deleted`). Optional: records predating the
        // field are treated `present`. Drives the reconciler's recover-vs-finish-delete.
        desiredState: { type: ["present", "deleted"] as const, required: false },
        // When a delete was requested (the `deleting` tombstone began).
        deleteRequestedAt: { type: "string", required: false },
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
        // Functional self-report from the in-workspace agent (is the desktop usable:
        // IDE reachable + workspace writable). Absent until the first report.
        functional: { type: ["ok", "degraded"] as const, required: false },
        functionalDetail: { type: "string", required: false },
        functionalAt: { type: "string", required: false },
        // Optimistic-concurrency version: every lifecycle write is conditioned
        // on the version it read, so concurrent transitions (e.g. two wakes
        // racing) cannot both win and leak a real ECS task.
        version: { type: "number", required: true, default: 0 },
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
        tags: { type: "list", items: { type: "string" }, required: false },
        tools: { type: "list", items: { type: "string" }, required: false },
        enabled: { type: "boolean", required: true },
        // Which editor workspaces from this image serve (openvscode | monaco). Optional:
        // records predating the field are treated as the default (OpenVSCode).
        editor: { type: ["openvscode", "monaco", "claude", "codex"] as const, required: false },
        createdAt: { type: "string", required: true },
        // Optimistic-concurrency version: every update is conditioned on the
        // version it read, so two concurrent admin edits cannot silently clobber
        // each other (mirrors the WorkspaceEntity version-CAS).
        version: { type: "number", required: true, default: 0 },
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

/**
 * ElectroDB git-credential entity over the same single table: one record per
 * owner holding their encrypted git token (AES-256-GCM ciphertext — never
 * plaintext). The boot-time credential broker reads it to clone/push private
 * repos; the GitHub API routes reuse it. Keyed by `ownerId` (+ provider).
 */
export function makeGitCredentialEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "gitCredential", version: "1", service: "edd" },
      attributes: {
        ownerId: { type: "string", required: true },
        provider: { type: "string", required: true },
        // AES-256-GCM ciphertext (iv.tag.ct base64) of the git token.
        ciphertext: { type: "string", required: true },
        updatedAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["ownerId"] },
          sk: { field: "SK", composite: ["provider"] },
        },
      },
    },
    { client, table },
  );
}

export type GitCredentialEntity = ReturnType<typeof makeGitCredentialEntity>;

/**
 * ElectroDB SSH-key entity over the same single table. Account-level public keys
 * a user registers for SSH access. `primary` lists a user's keys (PK=ownerId,
 * SK=keyId); `byFingerprint` (GSI1) resolves a presented public key to its owner
 * for the gateway's authorized-keys lookup — and backs global key uniqueness (a
 * public key identifies exactly one user). Only the *public* key is stored; the
 * private key never reaches the server.
 */
export function makeSshKeyEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "sshKey", version: "1", service: "edd" },
      attributes: {
        id: { type: "string", required: true },
        ownerId: { type: "string", required: true },
        label: { type: "string", required: true },
        keyType: { type: "string", required: true },
        fingerprint: { type: "string", required: true },
        publicKey: { type: "string", required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["ownerId"] },
          sk: { field: "SK", composite: ["id"] },
        },
        byFingerprint: {
          index: "GSI1",
          pk: { field: "GSI1PK", composite: ["fingerprint"] },
          sk: { field: "GSI1SK", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export type SshKeyEntity = ReturnType<typeof makeSshKeyEntity>;

/**
 * Fingerprint-claim sentinel that enforces GLOBAL SSH-key uniqueness. A DynamoDB
 * GSI is not a uniqueness constraint, so the `byFingerprint` index on `sshKey`
 * alone is racy (two concurrent registrations of the same key both pass a read and
 * both write). This entity keys a single item by `fingerprint` on the table's
 * primary key, so a conditional `create()` (`attribute_not_exists`) is the
 * uniqueness lock: `SshKeyService.register` writes the claim and the key in one
 * `writeTransaction`, and a second writer's claim fails the condition — exactly one
 * registration can ever own a fingerprint. Stores the owning `ownerId`/`keyId` so a
 * conflict can report whether the existing key is the caller's own.
 */
export function makeSshKeyFingerprintEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "sshKeyFingerprint", version: "1", service: "edd" },
      attributes: {
        fingerprint: { type: "string", required: true },
        ownerId: { type: "string", required: true },
        keyId: { type: "string", required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["fingerprint"] },
          sk: { field: "SK", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export type SshKeyFingerprintEntity = ReturnType<typeof makeSshKeyFingerprintEntity>;

/**
 * ElectroDB append-only audit-event entity over the same single table: one
 * record per control-plane action (actor + action + target + when). `byTime`
 * lists newest-first from one static partition (mirrors the base-image catalog
 * index) for the admin audit feed.
 */
export function makeAuditEventEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "auditEvent", version: "1", service: "edd" },
      attributes: {
        id: { type: "string", required: true },
        at: { type: "string", required: true },
        actor: { type: "string", required: true },
        action: { type: "string", required: true },
        target: { type: "string", required: true },
        detail: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["id"] },
          sk: { field: "SK", composite: [] },
        },
        byTime: {
          index: "GSI1",
          pk: { field: "GSI1PK", composite: [] },
          sk: { field: "GSI1SK", composite: ["at", "id"] },
        },
      },
    },
    { client, table },
  );
}

export type AuditEventEntity = ReturnType<typeof makeAuditEventEntity>;

/**
 * ElectroDB cost-rollup entity over the same single table: one record per
 * workspace holding its accumulated billing state at a checkpoint (running/stopped
 * ms + open phase), so the admin Costs report can resume pricing from the
 * checkpoint — replaying only the events since it — instead of re-deriving the
 * whole audit ledger each request. `byAll` lists every rollup (one checkpoint
 * generation at a time). Figures are unchanged — see the figure-equivalence integ.
 */
export function makeCostRollupEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "costRollup", version: "1", service: "edd" },
      attributes: {
        workspaceId: { type: "string", required: true },
        owner: { type: "string", required: true },
        checkpointAt: { type: "string", required: true },
        windowStart: { type: "string", required: true },
        runningMs: { type: "number", required: true },
        stoppedMs: { type: "number", required: true },
        teardownMs: { type: "number", required: true, default: 0 },
        phase: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["workspaceId"] },
          sk: { field: "SK", composite: [] },
        },
        byAll: {
          index: "GSI1",
          pk: { field: "GSI1PK", composite: [] },
          sk: { field: "GSI1SK", composite: ["workspaceId"] },
        },
      },
    },
    { client, table },
  );
}

export type CostRollupEntity = ReturnType<typeof makeCostRollupEntity>;

/**
 * ElectroDB reconciler-heartbeat entity over the same single table: a single
 * record the reconciler stamps with the time of its last successful sweep, so the
 * admin Health board can report the reconciler `degraded` when the scale-to-zero/
 * snapshot/GC loop has stalled (no recent sweep). One fixed-id record — a plain
 * get/put, no secondary index.
 */
export function makeReconcilerHeartbeatEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "reconcilerHeartbeat", version: "1", service: "edd" },
      attributes: {
        id: { type: "string", required: true },
        lastRunAt: { type: "string", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["id"] },
          sk: { field: "SK", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export type ReconcilerHeartbeatEntity = ReturnType<typeof makeReconcilerHeartbeatEntity>;

/** The fixed primary-key id of the singleton reconciler-heartbeat record. */
export const RECONCILER_HEARTBEAT_ID = "reconciler";

/**
 * ElectroDB per-owner workspace-count entity over the same single table: one record
 * per owner holding their live workspace count, so the create path can enforce the
 * per-user quota ATOMICALLY. A read-then-create check is racy (concurrent creates all
 * pass the read and all create → quota bypass). Instead `WorkspaceService.create`
 * issues, in ONE `writeTransaction` with the workspace insert, an atomic `ADD count 1`
 * guarded by `attribute_not_exists(count) OR count < limit` — so the (limit+1)th
 * concurrent create's transaction cancels and exactly `limit` can ever exist.
 * `finishDeleting` decrements it when a record is actually removed. One item per owner
 * keyed by `ownerId` — a plain conditional update, no secondary index.
 */
export function makeOwnerWorkspaceCountEntity(client: DynamoDBClient, table = TABLE) {
  return new Entity(
    {
      model: { entity: "ownerWorkspaceCount", version: "1", service: "edd" },
      attributes: {
        ownerId: { type: "string", required: true },
        count: { type: "number", required: true },
      },
      indexes: {
        primary: {
          pk: { field: "PK", composite: ["ownerId"] },
          sk: { field: "SK", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export type OwnerWorkspaceCountEntity = ReturnType<typeof makeOwnerWorkspaceCountEntity>;
