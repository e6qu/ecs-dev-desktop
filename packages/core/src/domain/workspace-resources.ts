// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EditorKind } from "./editor";

export const WORKSPACE_CPU_UNITS = [512, 1024, 2048, 4096] as const;
export type WorkspaceCpuUnits = (typeof WORKSPACE_CPU_UNITS)[number];

export const WORKSPACE_MEMORY_MIB = [2048, 4096, 8192, 16384] as const;
export type WorkspaceMemoryMiB = (typeof WORKSPACE_MEMORY_MIB)[number];

export const WORKSPACE_VOLUME_GIB = [8, 16, 32, 64] as const;
export type WorkspaceVolumeGiB = (typeof WORKSPACE_VOLUME_GIB)[number];

export const DEFAULT_WORKSPACE_CPU_UNITS: WorkspaceCpuUnits = 512;
export const DEFAULT_WORKSPACE_MEMORY_MIB: WorkspaceMemoryMiB = 2048;
export const DEFAULT_WORKSPACE_VOLUME_GIB: WorkspaceVolumeGiB = 8;

export interface WorkspaceResources {
  readonly cpuUnits: WorkspaceCpuUnits;
  readonly memoryMiB: WorkspaceMemoryMiB;
  readonly volumeGiB: WorkspaceVolumeGiB;
}

/**
 * Per-editor DEFAULT resources, chosen from each editor's real footprint and Fargate's
 * valid CPU:memory pairs. These are the PRE-SELECTED defaults at create time — a caller
 * may still pick any smaller valid tier — not a hard floor. The flat 0.5 vCPU / 2 GiB was
 * too small for the heavy editors (users could open an OOM-prone workspace by accident):
 *
 *  - `terminal` — a shell + xterm tabs. Light: 0.5 vCPU / 2 GiB.
 *  - `monaco` — the first-party lightweight Monaco editor server. Light: 0.5 vCPU / 2 GiB.
 *  - `openvscode` — the full OpenVSCode Server; the extension host + language servers
 *    (TypeScript et al.) routinely exceed 2 GiB, so 1 vCPU / 4 GiB.
 *  - `opencode` — the `opencode web` server plus its agent running builds/tools: 1 vCPU / 4 GiB.
 *
 * Volume stays at {@link DEFAULT_WORKSPACE_VOLUME_GIB} for all; only CPU/memory vary by editor.
 * Every pair here satisfies {@link isValidWorkspaceResourcePair}.
 */
export const DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR: Readonly<
  Record<EditorKind, WorkspaceResources>
> = {
  terminal: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: DEFAULT_WORKSPACE_VOLUME_GIB },
  monaco: { cpuUnits: 512, memoryMiB: 2048, volumeGiB: DEFAULT_WORKSPACE_VOLUME_GIB },
  openvscode: { cpuUnits: 1024, memoryMiB: 4096, volumeGiB: DEFAULT_WORKSPACE_VOLUME_GIB },
  opencode: { cpuUnits: 1024, memoryMiB: 4096, volumeGiB: DEFAULT_WORKSPACE_VOLUME_GIB },
};

/** The pre-selected default resources for a given editor (see
 * {@link DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR}). */
export function defaultResourcesForEditor(editor: EditorKind): WorkspaceResources {
  return DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR[editor];
}

export interface WorkspaceResourceInput {
  readonly cpuUnits: number;
  readonly memoryMiB: number;
  readonly volumeGiB: number;
}

function isWorkspaceCpuUnits(value: number): value is WorkspaceCpuUnits {
  return WORKSPACE_CPU_UNITS.includes(value as WorkspaceCpuUnits);
}

function isWorkspaceMemoryMiB(value: number): value is WorkspaceMemoryMiB {
  return WORKSPACE_MEMORY_MIB.includes(value as WorkspaceMemoryMiB);
}

function isWorkspaceVolumeGiB(value: number): value is WorkspaceVolumeGiB {
  return WORKSPACE_VOLUME_GIB.includes(value as WorkspaceVolumeGiB);
}

export function isValidWorkspaceResourcePair(
  resources: WorkspaceResourceInput,
): resources is WorkspaceResources {
  const { cpuUnits, memoryMiB } = resources;
  if (!isWorkspaceCpuUnits(cpuUnits)) return false;
  if (!isWorkspaceMemoryMiB(memoryMiB)) return false;
  if (!isWorkspaceVolumeGiB(resources.volumeGiB)) return false;
  switch (cpuUnits) {
    case 512:
      return memoryMiB === 2048 || memoryMiB === 4096;
    case 1024:
      return memoryMiB === 2048 || memoryMiB === 4096 || memoryMiB === 8192;
    case 2048:
      return memoryMiB === 4096 || memoryMiB === 8192 || memoryMiB === 16384;
    case 4096:
      return memoryMiB === 8192 || memoryMiB === 16384;
  }
}

export function assertValidWorkspaceResources(
  resources: WorkspaceResourceInput,
): WorkspaceResources {
  if (!isValidWorkspaceResourcePair(resources)) {
    throw new Error(
      `invalid workspace resources: ${resources.cpuUnits.toString()} CPU units with ${resources.memoryMiB.toString()} MiB memory and ${resources.volumeGiB.toString()} GiB volume`,
    );
  }
  return resources;
}
