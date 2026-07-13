// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { decideControlPlaneWake } from "./control-plane-scale";
import {
  WAKE_RESPONSE_ACTION_HEADER,
  WAKE_RESPONSE_CACHE_CONTROL,
  WAKE_RESPONSE_CONTENT_TYPE,
  WAKE_RESPONSE_STATUS,
  decideWakeResponse,
  renderStartupPage,
} from "./wake-listener";

describe("renderStartupPage", () => {
  it("reloads on a timer (no readiness poll) — the reload is the readiness check", () => {
    const html = renderStartupPage({ reloadIntervalMs: 3000, title: "Starting EDD…" });
    expect(html).toContain("window.location.reload()");
    expect(html).toContain("setTimeout(");
    expect(html).toContain("3000");
    // There is no poll: the page never fetches anything (CloudFront serves this page for every
    // request while the control plane is down, so there is nothing to poll).
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("setInterval(");
    // No external assets — no remote src/href/link references.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<link\b/);
  });

  it("renders the title as escaped HTML text", () => {
    const html = renderStartupPage({
      reloadIntervalMs: 3000,
      title: "<script>alert(1)</script>",
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("sets a noscript meta refresh derived from the reload interval", () => {
    const html = renderStartupPage({ reloadIntervalMs: 3000, title: "t" });
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="3" /></noscript>');
  });

  it("fails loud on a non-positive or non-finite reload interval", () => {
    expect(() => renderStartupPage({ reloadIntervalMs: 0, title: "t" })).toThrow(
      /positive finite number/,
    );
    expect(() => renderStartupPage({ reloadIntervalMs: Number.NaN, title: "t" })).toThrow(
      /positive finite number/,
    );
  });
});

describe("decideWakeResponse", () => {
  it("always serves a 200 reloading page with no-store, echoing the wake action", () => {
    const decision = decideControlPlaneWake({ currentDesired: 0, activeDesired: 2 });
    const res = decideWakeResponse({
      decision,
      page: { reloadIntervalMs: 3000, title: "Starting EDD…" },
    });
    expect(res.statusCode).toBe(WAKE_RESPONSE_STATUS);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(WAKE_RESPONSE_CONTENT_TYPE);
    expect(res.headers["cache-control"]).toBe(WAKE_RESPONSE_CACHE_CONTROL);
    expect(res.headers[WAKE_RESPONSE_ACTION_HEADER]).toBe("wake");
    expect(res.body).toContain("window.location.reload()");
  });

  it("still serves the page (hold) when the service is already at desired", () => {
    const decision = decideControlPlaneWake({ currentDesired: 2, activeDesired: 2 });
    const res = decideWakeResponse({
      decision,
      page: { reloadIntervalMs: 3000, title: "Starting EDD…" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[WAKE_RESPONSE_ACTION_HEADER]).toBe("hold");
  });
});
