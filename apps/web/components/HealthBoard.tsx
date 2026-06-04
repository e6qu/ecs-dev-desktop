// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { HealthReportDto } from "@edd/api-contracts";
import { useEffect, useState } from "react";

import { TESTID } from "../lib/testids";

const api = new ApiClient({ baseUrl: "" });
const POLL_MS = 5000;

export function HealthBoard() {
  const [report, setReport] = useState<HealthReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      try {
        const r = await api.adminHealth();
        if (active) {
          setReport(r);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "health check failed");
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (error !== null) return <div className="notice">health check failed: {error}</div>;
  if (report === null)
    return (
      <div className="empty">
        <div className="big">checking…</div>
      </div>
    );

  return (
    <>
      <div className="health-head">
        <span className="badge" data-h={report.status}>
          <span className="dot pulse" />
          {report.status}
        </span>
        <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          checked {new Date(report.checkedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="health-rows">
        {report.components.map((c) => (
          <div
            key={c.component}
            className="health-row"
            data-testid={TESTID.healthRow}
            data-component={c.component}
            data-h={c.status}
          >
            <span className="badge" data-h={c.status}>
              <span className="dot" />
              {c.status}
            </span>
            <span className="name">{c.component}</span>
            <span className="detail">{c.detail ?? ""}</span>
          </div>
        ))}
      </div>
    </>
  );
}
