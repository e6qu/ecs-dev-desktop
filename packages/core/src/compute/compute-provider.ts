// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BaseImage,
  IsoTimestamp,
  SnapshotId,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "../domain/ids";
import type { ComponentHealth } from "../observability/health";

/**
 * ComputeProvider — runs a workspace's container task on Fargate with an
 * ECS-**managed** EBS volume. `runTask` creates that volume (hydrating it from a
 * snapshot when waking) and returns its id; the volume's create/release lifecycle
 * is owned here, while the {@link StorageProvider} handles snapshots, restore
 * lifecycle, and GC on that id. The real adapter is ECS Fargate RunTask/StopTask;
 * a {@link FakeComputeProvider} backs unit/integration tests without AWS.
 */
export interface ComputeTask {
  readonly id: TaskId;
  /** The ECS-managed EBS volume created for (and released with) the task. */
  readonly volumeId: VolumeId;
  /** Private IP of the task's ENI (awsvpc). The SSH gateway forwards to this address. Undefined when the compute backend doesn't expose it (e.g. the fake). */
  readonly sshHost?: string;
}

export interface RunTaskInput {
  workspaceId: WorkspaceId;
  baseImage: BaseImage;
  /** Hydrate the managed volume from this snapshot (wake); omit for a fresh volume. */
  fromSnapshot?: SnapshotId;
  /** Git repo to clone into the session at first boot (fresh volume only); the
   * git credential is fetched by the in-workspace agent, not passed here. */
  repoUrl?: string;
  /** Branch/tag/SHA to check out (with `repoUrl`). */
  repoRef?: string;
}

/** Coarse liveness of a task as the compute platform sees it. A task that is
 * on its way up still counts as "running" (drift detection must not flag a
 * wake in progress); one that is stopping, stopped, or unknown is "stopped". */
export type TaskLiveness = "running" | "stopped";

/**
 * Live state of the compute cluster the workspace tasks run in (ECS
 * DescribeClusters on AWS). Surfaced on the admin Infrastructure view so an
 * operator can see fleet capacity and cluster health at a glance. The fake
 * reports its in-memory equivalent (local), never a fabricated cloud cluster.
 */
export interface ClusterInfo {
  /** Cluster name/identifier (the configured ECS cluster, or "local" for the fake). */
  readonly name: string;
  /** Cluster status — `ACTIVE` on a healthy ECS cluster; `local` for the fake. */
  readonly status: string;
  /** Tasks the platform reports as RUNNING. */
  readonly runningTasks: number;
  /** Tasks still PENDING/PROVISIONING. */
  readonly pendingTasks: number;
  /** ECS services registered on the cluster (0 for our task-only Fargate use). */
  readonly activeServices: number;
  /** Registered container instances (0 on Fargate — no EC2 capacity to register). */
  readonly registeredContainerInstances: number;
}

/**
 * A platform-managed workspace task as enumerated for orphan reaping: the running
 * task, the workspace it belongs to (read from its tag), and when it started (for
 * the grace window). The reconciler stops any whose workspace no longer references
 * them — the compute analogue of orphan-volume GC.
 */
export interface WorkspaceTaskRef {
  readonly id: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly startedAt: IsoTimestamp;
}

export interface ComputeProvider {
  /** Launch a task with a fresh or snapshot-hydrated managed EBS volume. */
  runTask(input: RunTaskInput): Promise<ComputeTask>;

  /** Stop the task; the platform releases its managed EBS volume. */
  stopTask(taskId: TaskId): Promise<void>;

  /** Enumerate RUNNING workspace tasks this platform launched (identified by the
   * per-workspace tag `runTask` sets), for the reconciler's orphan-task reaper.
   * Optional — absent ⇒ no compute reaping (a backend that can't list tagged tasks). */
  listWorkspaceTasks?(): Promise<readonly WorkspaceTaskRef[]>;

  /** Observed liveness of a task — the reconciler's drift-detection input
   * (a record claiming `running` whose task died out-of-band must stop
   * advertising live bindings). */
  taskState(taskId: TaskId): Promise<TaskLiveness>;

  /** Dependency health (admin Health board). Real adapters do a live check; absent
   * ⇒ reported as `unknown` (real check available on AWS). */
  health?(): Promise<ComponentHealth>;

  /** Live cluster capacity/state for the admin Infrastructure view. Real adapters
   * query the platform (ECS DescribeClusters); the fake reports its in-memory
   * equivalent. */
  clusterInfo?(): Promise<ClusterInfo>;
}
