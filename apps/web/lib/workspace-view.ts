// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceStateDto } from "@edd/api-contracts";

interface StatusMeta {
  label: string;
  pulse: boolean;
}

const STATUS: Record<WorkspaceStateDto, StatusMeta> = {
  provisioning: { label: "provisioning", pulse: true },
  running: { label: "running", pulse: true },
  idle: { label: "idle", pulse: false },
  stopping: { label: "stopping", pulse: true },
  stopped: { label: "stopped", pulse: false },
  deleting: { label: "deleting", pulse: true },
  error: { label: "error", pulse: false },
  terminated: { label: "terminated", pulse: false },
};

export function statusMeta(state: WorkspaceStateDto): StatusMeta {
  return STATUS[state];
}

// `availableActions` moved into `@edd/core` (`workspaceActions`) and now rides the
// workspace DTO (server-computed), so the UI renders action buttons from data rather
// than mirroring the control-plane state machine here.
