// SPDX-License-Identifier: AGPL-3.0-or-later
// Editor activity marker: touched (throttled) on real editor interaction so the
// idle-agent (infra/images/base/idle-agent.sh, which also watches /dev/pts/* and
// CPU load) can tell "in use" from "merely running" — the reconciler only keeps
// ACTIVE workspaces from scaling to zero. The Monaco server touches it on file
// mutations and terminal input; the OpenVSCode analogue lives in the
// edd-workspace-ui extension. tmpfs path, container-local.
import { writeFileSync } from "node:fs";

const ACTIVITY_MARKER = "/tmp/edd-activity";
const TOUCH_THROTTLE_MS = 30_000;

let lastTouch = 0;

/** Record "the user just did something" — best-effort and throttled (interaction
 * events fire per keystroke; one touch per throttle window is plenty). A missing
 * or read-only /tmp must never break the editor. */
export function touchActivity(now: () => number = Date.now): void {
  const at = now();
  if (at - lastTouch < TOUCH_THROTTLE_MS) return;
  lastTouch = at;
  try {
    writeFileSync(ACTIVITY_MARKER, "");
  } catch {
    // Best-effort by design (see above).
  }
}
