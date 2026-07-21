// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";

const fullGitRevision = /^[0-9a-f]{40,64}$/;

export function immutableReleaseEnvironment(
  configuredEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const applicationRevision = configuredEnv.APPLICATION_RELEASE_REVISION?.trim() ?? "";
  const buildRevision = configuredEnv.EDD_BUILD_SHA?.trim() ?? "";
  const explicitEnvironment: Record<string, string> = {};
  if (applicationRevision !== "") {
    explicitEnvironment.APPLICATION_RELEASE_REVISION = applicationRevision;
  }
  if (buildRevision !== "") {
    explicitEnvironment.EDD_BUILD_SHA = buildRevision;
  }
  if (Object.keys(explicitEnvironment).length > 0) return explicitEnvironment;

  const checkedOutRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!fullGitRevision.test(checkedOutRevision)) {
    throw new Error("git rev-parse HEAD did not return a full immutable source revision");
  }
  return { EDD_BUILD_SHA: checkedOutRevision };
}
