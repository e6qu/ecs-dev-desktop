// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { HealthReportDto } from "@edd/api-contracts";

import { usePoll } from "../lib/usePoll";
import { HealthHead, HealthRows } from "./HealthRows";

const api = new ApiClient({ baseUrl: "" });
const POLL_MS = 5000;
const load = (): Promise<HealthReportDto> => api.adminHealth();

export function HealthBoard() {
  const { data: report, error } = usePoll(load, POLL_MS, "health check failed");

  if (error !== null) return <div className="notice">health check failed: {error}</div>;
  if (report === null)
    return (
      <div className="empty">
        <div className="big">checking…</div>
      </div>
    );

  return (
    <>
      <HealthHead status={report.status} checkedAt={report.checkedAt} />
      <HealthRows components={report.components} />
    </>
  );
}
