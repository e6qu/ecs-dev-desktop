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

  // Only show a bare error when there is NO data yet. Once we have a report, a flaky
  // 5s poll must NOT blank the board — keep the last-known state with a "stale" banner.
  if (report === null) {
    if (error !== null) return <div className="notice">health check failed: {error}</div>;
    return (
      <div className="empty">
        <div className="big">checking…</div>
      </div>
    );
  }

  return (
    <>
      {error !== null && (
        <div className="notice" data-testid="stale-banner">
          last refresh failed ({error}) — showing the last known state
        </div>
      )}
      <HealthHead status={report.status} checkedAt={report.checkedAt} />
      <HealthRows components={report.components} />
    </>
  );
}
