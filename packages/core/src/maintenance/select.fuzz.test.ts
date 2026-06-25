// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for orphan-GC selection — the safety-critical
// core. The load-bearing invariant: GC NEVER selects a referenced (live) resource,
// for any mix of referenced ids / ages / grace. Also: selection is exactly the
// unreferenced-and-aged set, monotonic in the grace window, `retained` snapshots are
// never reaped, and a malformed timestamp fails safe (excluded, never reaped).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { WorkspaceAgentSecretRef, WorkspaceTaskRef } from "../compute/compute-provider";
import {
  isoTimestamp,
  snapshotId,
  taskId,
  volumeId,
  workspaceId,
  type TaskId,
  type VolumeId,
  type WorkspaceId,
} from "../domain/ids";
import type { SnapshotRef, VolumeRef } from "../storage/storage-provider";
import {
  selectDueForSnapshot,
  selectOrphanSecrets,
  selectOrphanSnapshots,
  selectOrphanTasks,
  selectOrphanVolumes,
} from "./select";
import type { SnapshotCandidate } from "./select";

const NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");
const NOW = isoTimestamp(new Date(NOW_MS).toISOString());
const iso = (ms: number): ReturnType<typeof isoTimestamp> =>
  isoTimestamp(new Date(ms).toISOString());

/** An array of volumes with unique ids + random ages, and a referenced-subset mask. */
const volumesArb = fc
  .array(
    fc.record({ ageMs: fc.integer({ min: 0, max: 30 * 86_400_000 }), referenced: fc.boolean() }),
    {
      minLength: 0,
      maxLength: 20,
    },
  )
  .map((rows) => {
    const existing: VolumeRef[] = rows.map((r, i) => ({
      id: volumeId(`vol-${String(i)}`),
      createdAt: iso(NOW_MS - r.ageMs),
    }));
    const referenced = new Set<VolumeId>(
      rows.flatMap((r, i) => (r.referenced ? [volumeId(`vol-${String(i)}`)] : [])),
    );
    return { existing, referenced, ages: rows.map((r) => r.ageMs) };
  });

describe("orphan-GC selection — properties", () => {
  it("selectOrphanVolumes NEVER returns a referenced id (the GC safety invariant)", () => {
    fc.assert(
      fc.property(
        volumesArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ existing, referenced }, grace) => {
          for (const id of selectOrphanVolumes(existing, referenced, NOW, grace)) {
            expect(referenced.has(id)).toBe(false);
          }
        },
      ),
    );
  });

  it("selectOrphanVolumes selects exactly the unreferenced volumes aged >= grace (inclusive)", () => {
    fc.assert(
      fc.property(
        volumesArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ existing, referenced, ages }, grace) => {
          const expected = existing
            .filter((v, i) => !referenced.has(v.id) && (ages[i] ?? 0) >= grace)
            .map((v) => v.id);
          expect(selectOrphanVolumes(existing, referenced, NOW, grace)).toEqual(expected);
        },
      ),
    );
  });

  it("selectOrphanVolumes is monotonic in grace — a larger window selects a subset", () => {
    fc.assert(
      fc.property(
        volumesArb,
        fc.integer({ min: 0, max: 15 * 86_400_000 }),
        fc.integer({ min: 0, max: 15 * 86_400_000 }),
        ({ existing, referenced }, g1, g2) => {
          const small = Math.min(g1, g2);
          const large = Math.max(g1, g2);
          const selLarge = new Set(selectOrphanVolumes(existing, referenced, NOW, large));
          const selSmall = new Set(selectOrphanVolumes(existing, referenced, NOW, small));
          for (const id of selLarge) expect(selSmall.has(id)).toBe(true);
        },
      ),
    );
  });

  it("selectOrphanSnapshots never reaps a `retained` snapshot, regardless of grace/reference", () => {
    const snapsArb = fc.array(
      fc.record({ ageMs: fc.integer({ min: 0, max: 30 * 86_400_000 }), retained: fc.boolean() }),
      { minLength: 0, maxLength: 20 },
    );
    fc.assert(
      fc.property(snapsArb, fc.integer({ min: 0, max: 30 * 86_400_000 }), (rows, grace) => {
        const existing: SnapshotRef[] = rows.map((r, i) => ({
          id: snapshotId(`snap-${String(i)}`),
          createdAt: iso(NOW_MS - r.ageMs),
          sourceVolumeId: volumeId(`vol-${String(i)}`),
          retained: r.retained,
        }));
        const selected = new Set(selectOrphanSnapshots(existing, new Set(), NOW, grace));
        for (const s of existing) if (s.retained === true) expect(selected.has(s.id)).toBe(false);
      }),
    );
  });

  it("selectOrphanVolumes fails safe on a malformed timestamp — never reaps it", () => {
    const existing: VolumeRef[] = [
      { id: volumeId("vol-bad"), createdAt: isoTimestamp("not-a-date") },
    ];
    // Unreferenced + any grace: a NaN age must NOT be treated as old enough to reap.
    expect(selectOrphanVolumes(existing, new Set(), NOW, 0)).toEqual([]);
  });

  it("selectDueForSnapshot always selects a never-snapshotted candidate and returns a subset", () => {
    const candArb = fc.array(
      fc.record({
        never: fc.boolean(),
        snapAgeMs: fc.integer({ min: 0, max: 30 * 86_400_000 }),
      }),
      { minLength: 0, maxLength: 20 },
    );
    fc.assert(
      fc.property(candArb, fc.integer({ min: 1, max: 30 * 86_400_000 }), (rows, intervalMs) => {
        const candidates: SnapshotCandidate[] = rows.map((r, i) => ({
          id: workspaceId(`ws-${String(i)}`),
          ...(r.never ? {} : { latestSnapshotAt: iso(NOW_MS - r.snapAgeMs) }),
        }));
        const selected = new Set(selectDueForSnapshot(candidates, NOW, intervalMs));
        const ids = new Set(candidates.map((c) => c.id));
        for (const id of selected) expect(ids.has(id)).toBe(true); // subset
        candidates.forEach((c) => {
          if (c.latestSnapshotAt === undefined) expect(selected.has(c.id)).toBe(true); // never-snapshotted ⇒ due
        });
      }),
    );
  });

  // ── selectOrphanTasks: the compute analogue of orphan-volume GC ──
  const tasksArb = fc
    .array(
      fc.record({ ageMs: fc.integer({ min: 0, max: 30 * 86_400_000 }), referenced: fc.boolean() }),
      { minLength: 0, maxLength: 20 },
    )
    .map((rows) => {
      const existing: WorkspaceTaskRef[] = rows.map((r, i) => ({
        id: taskId(`task-${String(i)}`),
        workspaceId: workspaceId(`ws-${String(i)}`),
        startedAt: iso(NOW_MS - r.ageMs),
      }));
      const referenced = new Set<TaskId>(
        rows.flatMap((r, i) => (r.referenced ? [taskId(`task-${String(i)}`)] : [])),
      );
      return { existing, referenced, ages: rows.map((r) => r.ageMs) };
    });

  it("selectOrphanTasks NEVER stops a referenced (live) task, and selects exactly unreferenced-aged", () => {
    fc.assert(
      fc.property(
        tasksArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ existing, referenced, ages }, grace) => {
          const selected = selectOrphanTasks(existing, referenced, NOW, grace);
          for (const t of selected) expect(referenced.has(t.id)).toBe(false);
          const expected = existing.filter(
            (t, i) => !referenced.has(t.id) && (ages[i] ?? 0) >= grace,
          );
          expect(selected).toEqual(expected);
        },
      ),
    );
  });

  it("selectOrphanTasks fails safe on a malformed startedAt — never reaps it", () => {
    const existing: WorkspaceTaskRef[] = [
      {
        id: taskId("task-bad"),
        workspaceId: workspaceId("ws-bad"),
        startedAt: isoTimestamp("nope"),
      },
    ];
    expect(selectOrphanTasks(existing, new Set(), NOW, 0)).toEqual([]);
  });

  // ── selectOrphanSecrets: the secrets-manager analogue ──
  const secretsArb = fc
    .array(fc.record({ ageMs: fc.integer({ min: 0, max: 30 * 86_400_000 }), live: fc.boolean() }), {
      minLength: 0,
      maxLength: 20,
    })
    .map((rows) => {
      const existing: WorkspaceAgentSecretRef[] = rows.map((r, i) => ({
        name: `edd/workspace/ws-${String(i)}/agent`,
        workspaceId: workspaceId(`ws-${String(i)}`),
        createdAt: iso(NOW_MS - r.ageMs),
      }));
      const live = new Set<WorkspaceId>(
        rows.flatMap((r, i) => (r.live ? [workspaceId(`ws-${String(i)}`)] : [])),
      );
      return { existing, live, ages: rows.map((r) => r.ageMs) };
    });

  it("selectOrphanSecrets NEVER reaps a live workspace's secret, and selects exactly orphaned-aged", () => {
    fc.assert(
      fc.property(
        secretsArb,
        fc.integer({ min: 0, max: 30 * 86_400_000 }),
        ({ existing, live, ages }, grace) => {
          const selected = selectOrphanSecrets(existing, live, NOW, grace);
          for (const s of selected) expect(live.has(s.workspaceId)).toBe(false);
          const expected = existing.filter(
            (s, i) => !live.has(s.workspaceId) && (ages[i] ?? 0) >= grace,
          );
          expect(selected).toEqual(expected);
        },
      ),
    );
  });

  it("selectOrphanSecrets fails safe on a malformed createdAt — never reaps it", () => {
    const existing: WorkspaceAgentSecretRef[] = [
      {
        name: "edd/workspace/ws-bad/agent",
        workspaceId: workspaceId("ws-bad"),
        createdAt: isoTimestamp("nope"),
      },
    ];
    expect(selectOrphanSecrets(existing, new Set(), NOW, 0)).toEqual([]);
  });
});
