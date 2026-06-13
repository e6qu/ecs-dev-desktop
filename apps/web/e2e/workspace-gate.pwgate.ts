// SPDX-License-Identifier: AGPL-3.0-or-later
// Live per-workspace authorization through the gate (DO_NEXT #5 / increment-2):
// a REAL browser drives Pomerium OIDC, then the workspace GATE (PEP) authorizes
// each request against the control-plane PDP before forwarding. This is the proof
// the in-process PDP e2e (app/api/internal/authz/route.e2e.ts) cannot give — the
// decision enforced in the live Pomerium routing path by a separate gate process.
//
// The whole chain is real: Chromium → Pomerium (TLS, SPKI-pinned) → wildcard
// route → workspace-gate → PDP (assertion verified vs Pomerium's JWKS + DynamoDB
// ownership) → upstream. The owner reaches the echo upstream (200, assertion
// present); the same authenticated user is denied at a workspace they do not own
// (403). Hosts are seeded by playwright.gate.config.ts's globalSetup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

import { expect, test } from "@playwright/test";

const PROXY_PORT = 8443;
const HOSTS_FILE = join(import.meta.dirname, "../temp/gate-hosts.json");

interface GateHosts {
  readonly ownerHost: string;
  readonly otherHost: string;
}

/** Read + validate the hosts the global setup seeded. */
function gateHosts(): GateHosts {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(HOSTS_FILE, "utf8"));
  } catch {
    throw new Error(`missing ${HOSTS_FILE} — gate-global-setup must run first`);
  }
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    if (typeof r.ownerHost === "string" && typeof r.otherHost === "string") {
      return { ownerHost: r.ownerHost, otherHost: r.otherHost };
    }
  }
  throw new Error(`malformed ${HOSTS_FILE}`);
}

const proxyUrl = (host: string): string => `https://${host}:${String(PROXY_PORT)}/`;

test("the gate forwards the owner to the workspace upstream after Pomerium login", async ({
  page,
}) => {
  const { ownerHost } = gateHosts();
  const resp = await page.goto(proxyUrl(ownerHost));
  expect(resp?.status(), "owner should reach the upstream through the gate").toBe(200);
  expect(new URL(page.url()).hostname).toBe(ownerHost);
  // whoami echoes request headers; the injected assertion proves the request
  // traversed Pomerium → gate → upstream (not a short-circuited gate response).
  const body = await page.locator("body").innerText();
  expect(body).toMatch(/X-Pomerium-Jwt-Assertion/i);
});

test("the gate denies an authenticated non-owner at a workspace they do not own", async ({
  page,
}) => {
  const { ownerHost, otherHost } = gateHosts();
  // Establish the authenticated session (the owner host succeeds)…
  const ok = await page.goto(proxyUrl(ownerHost));
  expect(ok?.status()).toBe(200);
  // …then the SAME authenticated user hits a workspace owned by someone else →
  // the gate's PDP denies before forwarding (403, no upstream echo).
  const denied = await page.goto(proxyUrl(otherHost));
  expect(denied?.status(), "non-owner must be denied at the gate (PDP)").toBe(403);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/X-Pomerium-Jwt-Assertion/i);
});
