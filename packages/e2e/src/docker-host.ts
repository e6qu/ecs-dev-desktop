// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

/**
 * Host coordinate injected into Sockerless-launched workloads. Docker needs
 * the host.docker.internal coordinate that the simulator maps into each task;
 * Podman already publishes host.containers.internal inside nested containers.
 * Using the Docker name on Podman is incorrect because the simulator rewrites
 * it to the outer container's default gateway, which is not the host bridge.
 */
function detectSimulatorWorkloadHost(): string {
  const version = spawnSync("docker", ["version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (version.status !== 0) {
    const reason = version.error?.message ?? version.stderr.trim();
    throw new Error(`docker version failed: ${reason.length > 0 ? reason : "unknown error"}`);
  }
  return /Podman Engine/i.test(version.stdout)
    ? "host.containers.internal"
    : "host.docker.internal";
}

export const simulatorWorkloadHost = detectSimulatorWorkloadHost();

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
