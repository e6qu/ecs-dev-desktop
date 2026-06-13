// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";

import { VSCODE_CONTAINER } from "./vscode-support";

/** Remove the workspace container (keep local disk clean — no leftover image
 * containers on the podman VM). */
export default function globalTeardown(): void {
  execFileSync("docker", ["rm", "-f", VSCODE_CONTAINER], { stdio: "ignore" });
}
