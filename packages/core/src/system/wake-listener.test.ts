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

const STATUS_URL = "https://app.edd.example.dev/api/readyz";

describe("renderStartupPage", () => {
  it("embeds the status URL and poll interval in the inline script", () => {
    const html = renderStartupPage({
      statusUrl: STATUS_URL,
      pollIntervalMs: 3000,
      title: "Starting EDD…",
    });
    expect(html).toContain(`var statusUrl = "${STATUS_URL}";`);
    expect(html).toContain("var intervalMs = 3000;");
    expect(html).toContain("setInterval(poll, intervalMs)");
    expect(html).toContain("window.location.reload()");
    // No external assets — no remote src/href/link references.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<link\b/);
  });

  it("renders the title as escaped HTML text", () => {
    const html = renderStartupPage({
      statusUrl: STATUS_URL,
      pollIntervalMs: 3000,
      title: "<script>alert(1)</script>",
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes a status URL so it cannot break out of the inline script", () => {
    const nasty = 'https://x/</script><script>alert(1)</script>?"';
    const html = renderStartupPage({ statusUrl: nasty, pollIntervalMs: 3000, title: "t" });
    // The raw closing-script sequence must not appear inside the embedded literal.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("sets a noscript meta refresh derived from the poll interval", () => {
    const html = renderStartupPage({ statusUrl: STATUS_URL, pollIntervalMs: 3000, title: "t" });
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="3" /></noscript>');
  });

  it("fails loud on an empty status URL", () => {
    expect(() => renderStartupPage({ statusUrl: "", pollIntervalMs: 3000, title: "t" })).toThrow(
      /statusUrl must be non-empty/,
    );
  });

  it("fails loud on a non-positive or non-finite poll interval", () => {
    expect(() =>
      renderStartupPage({ statusUrl: STATUS_URL, pollIntervalMs: 0, title: "t" }),
    ).toThrow(/positive finite number/);
    expect(() =>
      renderStartupPage({ statusUrl: STATUS_URL, pollIntervalMs: Number.NaN, title: "t" }),
    ).toThrow(/positive finite number/);
  });
});

describe("decideWakeResponse", () => {
  it("serves a 200 startup page with no-store, echoing the wake action", () => {
    const decision = decideControlPlaneWake({ currentDesired: 0, activeDesired: 2 });
    const res = decideWakeResponse({
      decision,
      page: { statusUrl: STATUS_URL, pollIntervalMs: 3000, title: "Starting EDD…" },
    });
    expect(res.statusCode).toBe(WAKE_RESPONSE_STATUS);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(WAKE_RESPONSE_CONTENT_TYPE);
    expect(res.headers["cache-control"]).toBe(WAKE_RESPONSE_CACHE_CONTROL);
    expect(res.headers[WAKE_RESPONSE_ACTION_HEADER]).toBe("wake");
    expect(res.body).toContain(`var statusUrl = "${STATUS_URL}";`);
  });

  it("still serves the page (hold) when the service is already at desired", () => {
    const decision = decideControlPlaneWake({ currentDesired: 2, activeDesired: 2 });
    const res = decideWakeResponse({
      decision,
      page: { statusUrl: STATUS_URL, pollIntervalMs: 3000, title: "Starting EDD…" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[WAKE_RESPONSE_ACTION_HEADER]).toBe("hold");
  });
});
