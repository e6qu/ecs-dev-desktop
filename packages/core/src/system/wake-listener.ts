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

/** Default cadence at which the startup page RELOADS itself (the reload is the readiness check). */
export const DEFAULT_WAKE_RELOAD_INTERVAL_MS = 3000;

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
  /** How often (ms, positive/finite) the page RELOADS itself. There is no readiness poll: the
   * page is served BY the wake Lambda via CloudFront's 503 `custom_error_response`, so while the
   * control plane is down every request (including a readiness poll) returns this same page. A
   * blind reload is therefore the readiness check — a reload lands on the real app once the ALB
   * has a healthy target, and on this page again (re-triggering the wake) while it is still down. */
  readonly reloadIntervalMs: number;
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
 * Render the self-refreshing "Starting EDD…" status page (pure). The page has no external assets —
 * inline CSS + a tiny inline script that RELOADS the current URL every `reloadIntervalMs`. There is
 * no readiness poll: CloudFront serves this page (via the 503 `custom_error_response`) for every
 * request while the control plane is down, so the reload itself is the readiness check — it lands on
 * the real app once the ALB has a healthy target. A `<noscript>` meta refresh keeps a no-JS client
 * retrying too.
 *
 * Fails loud (§6.5) on a non-positive/non-finite reload interval rather than emitting a broken page.
 */
export function renderStartupPage(config: StartupPageConfig): string {
  const { reloadIntervalMs, title } = config;
  if (!Number.isFinite(reloadIntervalMs) || reloadIntervalMs <= 0) {
    throw new Error(
      `renderStartupPage: reloadIntervalMs must be a positive finite number, got ${String(reloadIntervalMs)}`,
    );
  }
  const safeTitle = escapeHtml(title);
  const intervalLiteral = String(Math.floor(reloadIntervalMs));
  const noscriptRefreshSeconds = Math.max(1, Math.ceil(reloadIntervalMs / 1000));

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
  // No readiness poll: while the control plane is down, CloudFront's 503 custom_error_response
  // serves THIS page for every request, so there is nothing to poll. Just reload on a timer — the
  // reload is the readiness check: it lands on the real app once the ALB has a healthy target, and
  // on this page again (re-triggering the wake) while still down. Reload the CURRENT url so a deep
  // link is preserved.
  setTimeout(function () { window.location.reload(); }, ${intervalLiteral});
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
 * Decide the HTTP response the wake listener returns (pure). Always the self-refreshing startup
 * page with **HTTP 200 + `Cache-Control: no-store`** — never a 5xx:
 *
 * - The wake Lambda is served BY CloudFront's 503 `custom_error_response` (response_code 200), so
 *   returning a 5xx here would just re-trigger the error handler; a 200 is what actually reaches
 *   the browser and renders the page.
 * - The page reloads itself on a timer (the reload is the readiness check), so no HTTP retry
 *   semantics are needed for convergence.
 * - `no-store` is load-bearing: it keeps the transient page from being cached over the real app
 *   once the control plane is back.
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
