// SPDX-License-Identifier: AGPL-3.0-or-later
import { InMemoryMetricSink, type StructuredLogger } from "@edd/core";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER, withObservability, type ObservabilityDeps } from "./observability";

function deps(): { deps: ObservabilityDeps; metrics: InMemoryMetricSink; logs: string[] } {
  const metrics = new InMemoryMetricSink();
  const logs: string[] = [];
  const log: StructuredLogger = {
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
    error: (m) => logs.push(`error:${m}`),
  };
  // A clock that advances 5ms per read → deterministic non-zero latency.
  let t = 1000;
  return { deps: { metrics, log, now: () => (t += 5), id: () => "req-test-id" }, metrics, logs };
}

describe("withObservability", () => {
  it("records latency + request count by status class and passes the response through", async () => {
    const { deps: d, metrics } = deps();
    const wrapped = withObservability(
      "workspaces.list",
      (_req: Request) => Promise.resolve(NextResponse.json({ ok: true }, { status: 200 })),
      d,
    );

    const res = await wrapped(new Request("http://x/api/workspaces"));

    expect(res.status).toBe(200);
    const latency = metrics.recorded.find((m) => m.name === "api.request.latency_ms");
    expect(latency?.value).toBeGreaterThan(0);
    expect(latency?.dimensions).toMatchObject({ route: "workspaces.list", status: "2xx" });
    expect(metrics.recorded.some((m) => m.name === "api.request")).toBe(true);
    expect(metrics.recorded.some((m) => m.name === "api.request.error")).toBe(false);
  });

  it("counts a 5xx response as an error", async () => {
    const { deps: d, metrics } = deps();
    const wrapped = withObservability(
      "boom",
      (_req: Request) => Promise.resolve(NextResponse.json({ error: "x" }, { status: 503 })),
      d,
    );

    await wrapped(new Request("http://x/api/boom"));

    expect(metrics.recorded.some((m) => m.name === "api.request.error")).toBe(true);
    expect(metrics.recorded.find((m) => m.name === "api.request")?.dimensions?.status).toBe("5xx");
  });

  it("records a throw as a 5xx and re-throws", async () => {
    const { deps: d, metrics, logs } = deps();
    const wrapped = withObservability(
      "throws",
      (_req: Request): Promise<Response> => Promise.reject(new Error("nope")),
      d,
    );

    await expect(wrapped(new Request("http://x/api/throws"))).rejects.toThrow("nope");
    expect(metrics.recorded.some((m) => m.name === "api.request.error")).toBe(true);
    expect(logs).toContain("error:api request threw");
  });

  it("stamps the correlation id on the response header", async () => {
    const { deps: d } = deps();
    const wrapped = withObservability(
      "workspaces.list",
      (_req: Request) => Promise.resolve(NextResponse.json({ ok: true })),
      d,
    );

    const res = await wrapped(new Request("http://x/api/workspaces"));
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req-test-id");
  });
});
