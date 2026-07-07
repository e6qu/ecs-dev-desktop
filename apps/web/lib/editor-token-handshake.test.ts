// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end reproduction of the editor token handshake that produced the live
// "unauthorized" on Monaco/Claude/Codex editors: the REAL in-app proxy functions
// (editorTokenRedirect + proxyWorkspaceHttp) in front of the REAL first-party Monaco
// editor server, driving the exact production flow. Isolated unit-suite integration
// (local HTTP servers only) — no sim/Docker. This is the regression guard the flow
// lacked: editorTokenRedirect and the Monaco gate were each tested alone, but never
// together, so the cookie-name mismatch that broke the loop was invisible to CI.
import { deriveWorkspaceToken, workspaceId } from "@edd/core";
import { createEditorServer } from "@edd/editor-monaco";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { editorTokenRedirect, proxyWorkspaceHttp } from "./workspace-proxy";

const SECRET = "handshake-connection-secret-0123456789";
const WS = "ws-handshake-test";
const wsid = workspaceId(WS);
const BASE = `/w/${WS}/`;
const TOKEN = deriveWorkspaceToken(SECRET, wsid);
const DOC = { "sec-fetch-dest": "document" } as const;

let monaco: Server;
let proxy: Server;
let proxyPort = 0;

beforeAll(async () => {
  vi.stubEnv("EDD_CONNECTION_SECRET", SECRET);
  const root = mkdtempSync(join(tmpdir(), "edd-handshake-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>edd</title>");
  writeFileSync(join(root, "hello.txt"), "hi");

  // The REAL Monaco server, token-gated exactly like production (CONNECTION_TOKEN).
  monaco = createEditorServer({ root, basePath: BASE, spaDir: root, token: TOKEN });
  await new Promise<void>((r) => monaco.listen(0, "127.0.0.1", () => {
    r();
  }));
  const upstream = new URL(`http://127.0.0.1:${String((monaco.address() as AddressInfo).port)}`);

  // A minimal proxy mirroring server.ts's /w/<id>/ HTTP handler (authz elided): run
  // editorTokenRedirect, else forward via proxyWorkspaceHttp — the REAL functions.
  proxy = createServer((req, res) => {
    const redirect = editorTokenRedirect(req, wsid);
    if (redirect !== undefined) {
      res.writeHead(302, { location: redirect, "referrer-policy": "no-referrer" });
      res.end();
      return;
    }
    proxyWorkspaceHttp(upstream, req, res);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => {
    r();
  }));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(() => {
  monaco.close();
  proxy.close();
});

function at(path: string): string {
  return `http://127.0.0.1:${String(proxyPort)}${path}`;
}

describe("editor token handshake (proxy ⇄ Monaco, end-to-end)", () => {
  it("completes: doc nav → ?tkn → Set-Cookie → clean nav SERVES (never 401)", async () => {
    // 1. First document navigation — the proxy injects the connection token.
    const first = await fetch(at(BASE), { redirect: "manual", headers: DOC });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${BASE}?tkn=${TOKEN}`);

    // 2. The ?tkn navigation — the proxy forwards to Monaco, which validates it, SETS
    //    the edd-editor-token cookie, and redirects to the clean URL. The proxy MUST
    //    forward Monaco's Set-Cookie + Location back to the browser.
    const second = await fetch(at(`${BASE}?tkn=${TOKEN}`), { redirect: "manual", headers: DOC });
    expect(second.status).toBe(302);
    expect(second.headers.get("set-cookie") ?? "").toContain(`edd-editor-token=${TOKEN}`);
    expect(second.headers.get("location")).toBe(BASE);

    // 3. The clean navigation WITH the cookie — the proxy must NOT re-inject ?tkn
    //    (recognizing edd-editor-token), and Monaco must SERVE (200), not 401. This
    //    exact step returned 401 in production before the cookie-name fix.
    const third = await fetch(at(BASE), {
      redirect: "manual",
      headers: { ...DOC, cookie: `edd-editor-token=${TOKEN}` },
    });
    expect(third.status).toBe(200);
  });

  it("serves an authed sub-resource carrying the cookie (200)", async () => {
    const res = await fetch(at(`${BASE}api/tree`), {
      headers: { cookie: `edd-editor-token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("Monaco still gates a request with neither token nor cookie (401)", async () => {
    // A non-document sub-resource is not redirected by the proxy — Monaco's own gate
    // must reject it, proving the gate is real (not disabled).
    const res = await fetch(at(`${BASE}api/tree`), { headers: { "sec-fetch-dest": "empty" } });
    expect(res.status).toBe(401);
  });
});
