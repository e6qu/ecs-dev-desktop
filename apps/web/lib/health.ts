// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEPLOY_SHA, DEPLOY_TIME } from "@edd/config";

interface DeployHealth {
  readonly sha: string;
  readonly time: string;
}

interface HealthStatus {
  status: "ok";
  service: "web";
  deploy: DeployHealth;
}

export function health(): HealthStatus {
  return { status: "ok", service: "web", deploy: { sha: DEPLOY_SHA, time: DEPLOY_TIME } };
}
