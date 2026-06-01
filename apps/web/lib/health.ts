// SPDX-License-Identifier: AGPL-3.0-or-later
export interface HealthStatus {
  status: "ok";
  service: "web";
}

export function health(): HealthStatus {
  return { status: "ok", service: "web" };
}
