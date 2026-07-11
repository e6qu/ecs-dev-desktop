// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Functional core for the control-plane wake listener (scale-to-zero). Pure
 * rendering + HTTP-response shaping for the AWS Lambda that CloudFront fails
 * over to when the control-plane ECS service is scaled to zero: it renders the
 * self-refreshing "Starting EDD…" status page and decides the HTTP status +
 * headers to return once the wake decision is known.
 *
 * All I/O (the ECS `DescribeServices` / `UpdateService` calls) lives in the
 * imperative shell (`@edd/wake-listener`); this file has no I/O, no clock, and
 * no platform reference — the poll cadence is passed in (§6.10), so the render
 * is deterministic and fully unit-testable.
 */
import type { ControlPlaneScaleDecision } from "./control-plane-scale";

/**
 * Default replica count to wake the control-plane ECS service to. The control
 * plane runs two replicas in production; the shell overrides this from
 * `EDD_CONTROL_PLANE_ACTIVE_DESIRED` (a deployment coordinate, §6.9).
 */
export const DEFAULT_CONTROL_PLANE_ACTIVE_DESIRED = 2;

/** Default cadence at which the startup page polls the readiness coordinate. */
export const DEFAULT_WAKE_POLL_INTERVAL_MS = 3000;

/** Default browser-tab / heading title for the startup page. */
export const DEFAULT_WAKE_PAGE_TITLE = "Starting EDD…";

/** HTTP status the wake listener serves the startup page with. See {@link decideWakeResponse}. */
export const WAKE_RESPONSE_STATUS = 200;

/** `Content-Type` of the startup page. */
export const WAKE_RESPONSE_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * `Cache-Control` of the startup page. Load-bearing: the page is a TRANSIENT
 * cold-start placeholder, so it must never be cached — otherwise a CDN or the
 * browser could serve it over the real app after the control plane is back.
 */
export const WAKE_RESPONSE_CACHE_CONTROL = "no-store, must-revalidate";

/** Response header carrying the wake decision's action, for observability. */
export const WAKE_RESPONSE_ACTION_HEADER = "x-edd-wake-action";

/** Inputs to {@link renderStartupPage}. */
export interface StartupPageConfig {
  /** The readiness coordinate the page polls (e.g. the control plane's `/api/readyz`). */
  readonly statusUrl: string;
  /** Poll cadence in milliseconds (positive, finite). */
  readonly pollIntervalMs: number;
  /** Page title / heading. */
  readonly title: string;
}

/** Escape a string for HTML text / attribute content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Encode a string as a safe JavaScript string literal for embedding in an
 * inline `<script>`: JSON-encode (quotes/backslashes/control chars), then
 * neutralize the sequences that could break out of the script element or the
 * surrounding HTML (`<`, `>`, `&`) and the JS line separators U+2028/U+2029.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Render the self-refreshing "Starting EDD…" status page (pure). The page has
 * no external assets — inline CSS + a tiny inline script that polls
 * {@link StartupPageConfig.statusUrl} every `pollIntervalMs` and reloads the
 * current URL once the readiness coordinate returns a 2xx. A `<noscript>` meta
 * refresh keeps a no-JS client retrying too.
 *
 * Fails loud (§6.5) on an empty status URL or a non-positive/non-finite poll
 * interval rather than emitting a broken page.
 */
export function renderStartupPage(config: StartupPageConfig): string {
  const { statusUrl, pollIntervalMs, title } = config;
  if (statusUrl.length === 0) {
    throw new Error("renderStartupPage: statusUrl must be non-empty");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `renderStartupPage: pollIntervalMs must be a positive finite number, got ${String(pollIntervalMs)}`,
    );
  }
  const safeTitle = escapeHtml(title);
  const statusUrlLiteral = jsStringLiteral(statusUrl);
  const intervalLiteral = String(Math.floor(pollIntervalMs));
  const noscriptRefreshSeconds = Math.max(1, Math.ceil(pollIntervalMs / 1000));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${safeTitle}</title>
<noscript><meta http-equiv="refresh" content="${String(noscriptRefreshSeconds)}" /></noscript>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100%; padding: 2rem;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0b0f17; color: #e6edf3;
  }
  @media (prefers-color-scheme: light) {
    body { background: #f6f8fa; color: #1f2328; }
  }
  main { max-width: 26rem; width: 100%; text-align: center; }
  .spinner {
    width: 2.5rem; height: 2.5rem; margin: 0 auto 1.5rem;
    border: 3px solid currentColor; border-right-color: transparent;
    border-radius: 50%; opacity: 0.55;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; font-size: 0.95rem; line-height: 1.5; opacity: 0.75; }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
</head>
<body>
<main role="status" aria-live="polite">
  <div class="spinner" aria-hidden="true"></div>
  <h1>${safeTitle}</h1>
  <p>Your workspace control plane is waking up. This page reloads automatically once it is ready.</p>
</main>
<script>
(function () {
  var statusUrl = ${statusUrlLiteral};
  var intervalMs = ${intervalLiteral};
  var stopped = false;
  function ready() {
    if (stopped) return;
    stopped = true;
    window.location.reload();
  }
  function poll() {
    if (stopped) return;
    fetch(statusUrl, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) { if (res.ok) { ready(); } })
      .catch(function () { /* control plane still down; keep polling */ });
  }
  setInterval(poll, intervalMs);
  poll();
})();
</script>
</body>
</html>
`;
}

/** A fully-shaped HTTP response the wake listener returns. */
export interface WakeHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Inputs to {@link decideWakeResponse}. */
export interface WakeResponseInput {
  /** The scale decision produced by `decideControlPlaneWake`. */
  readonly decision: ControlPlaneScaleDecision;
  /** The startup page to render into the body. */
  readonly page: StartupPageConfig;
}

/**
 * Decide the HTTP response the wake listener returns (pure). We serve the
 * self-refreshing startup page with **HTTP 200 + `Cache-Control: no-store`** in
 * every served case, rather than a `503 + Retry-After`:
 *
 * - The page re-polls readiness via inline JS and reloads on its own, so
 *   HTTP-level retry semantics (`Retry-After`) are not needed for convergence.
 * - A 200 guarantees the browser renders the HTML body; a 5xx from a CloudFront
 *   failover origin risks being intercepted by a custom-error-page config and
 *   never reaching the user.
 * - `no-store` is the load-bearing header: it prevents the transient page from
 *   being cached over the real app once the control plane is back.
 *
 * The wake decision's action is echoed in a response header for observability.
 */
export function decideWakeResponse(input: WakeResponseInput): WakeHttpResponse {
  const body = renderStartupPage(input.page);
  return {
    statusCode: WAKE_RESPONSE_STATUS,
    headers: {
      "content-type": WAKE_RESPONSE_CONTENT_TYPE,
      "cache-control": WAKE_RESPONSE_CACHE_CONTROL,
      [WAKE_RESPONSE_ACTION_HEADER]: input.decision.action,
    },
    body,
  };
}
