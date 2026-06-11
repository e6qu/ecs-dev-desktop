// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

/**
 * How a container reaches a server on the host: Docker Desktop / dockerd
 * support `--add-host host.docker.internal:host-gateway`; container runtimes
 * that don't (e.g. colima/podman variants) resolve `host.containers.internal`
 * natively. Probe once with the image we are about to run.
 */
export function hostReachableTarget(image: string): { host: string; dockerArgs: string[] } {
  const probe = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--entrypoint",
      "true",
      image,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (probe.status === 0) {
    return {
      host: "host.docker.internal",
      dockerArgs: ["--add-host", "host.docker.internal:host-gateway"],
    };
  }
  return { host: "host.containers.internal", dockerArgs: [] };
}
