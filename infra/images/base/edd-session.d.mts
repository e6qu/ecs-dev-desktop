// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for the workspace session registry (edd-session.mjs), which ships as a
// standalone script in the image but is imported by unit tests for its pure
// decisions. Declared here so those tests are type-checked like everything else
// rather than reaching into `any`.

/** Result shape of a tmux invocation, narrowed to what the registry reads. */
export interface TmuxResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type TmuxRunner = (...args: readonly string[]) => TmuxResult;

/** Session names tmux currently holds; empty when no server is running. */
export function liveSessions(run?: TmuxRunner): Set<string>;

/** The documented resume invocation for a recorded command, or null when the
 * agent has none. */
export function resumeCommandFor(command: string): string | null;

/** Waits until the session's pane runs a shell that can receive input. */
export function waitForShell(
  name: string,
  run?: TmuxRunner,
  attempts?: number,
  sleepMs?: number,
): boolean;
