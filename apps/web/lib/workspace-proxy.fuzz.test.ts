// SPDX-License-Identifier: AGPL-3.0-or-later
// Defence-in-depth boundary: the portal's Auth.js session cookie must NEVER be forwarded into a
// user-controlled workspace container, and the token-redirect decision runs in the proxy hot path
// so it must never throw. Property coverage for both.
import { workspaceId } from "@edd/core";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorTokenRedirect, stripSessionCookie } from "./workspace-proxy";

const STEM = "authjs.session-token";
const sessionName = fc.constantFrom(
  STEM,
  `__Secure-${STEM}`,
  `__Host-${STEM}`,
  `${STEM}.0`,
  `${STEM}.1`,
);
const nonSessionName = fc.stringMatching(/^[a-zA-Z0-9_]{1,12}$/).filter((n) => !n.includes(STEM));
const cookieVal = fc.stringMatching(/^[a-zA-Z0-9._-]{0,20}$/);
const pairsArb = fc.array(fc.tuple(fc.oneof(sessionName, nonSessionName), cookieVal), {
  maxLength: 10,
});

const namesOf = (header: string | undefined): string[] =>
  header === undefined ? [] : header.split(";").map((p) => p.split("=")[0]?.trim() ?? "");

describe("stripSessionCookie (fuzz)", () => {
  it("strips EVERY session cookie, preserves every non-session cookie, never throws", () => {
    fc.assert(
      fc.property(pairsArb, (pairs) => {
        const header = pairs.map(([n, v]) => `${n}=${v}`).join("; ");
        const out = stripSessionCookie(header);
        // No session cookie may survive.
        for (const name of namesOf(out)) expect(name.includes(STEM)).toBe(false);
        // Every non-session input name is preserved.
        for (const [n] of pairs.filter(([n]) => !n.includes(STEM))) {
          expect(namesOf(out)).toContain(n);
        }
      }),
    );
  });

  it("returns undefined (never '') for empty input or an all-session header", () => {
    expect(stripSessionCookie(undefined)).toBeUndefined();
    expect(stripSessionCookie("")).toBeUndefined();
    fc.assert(
      fc.property(fc.array(fc.tuple(sessionName, cookieVal), { minLength: 1 }), (pairs) => {
        const header = pairs.map(([n, v]) => `${n}=${v}`).join("; ");
        expect(stripSessionCookie(header)).toBeUndefined();
      }),
    );
  });
});

describe("editorTokenRedirect (fuzz)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const WS = workspaceId("ws-fuzz1");

  it("never throws for ANY method/url/headers — even crafted urls that break `new URL`", () => {
    vi.stubEnv("EDD_CONNECTION_SECRET", "fuzz-secret");
    fc.assert(
      fc.property(
        fc.record({
          method: fc.option(fc.constantFrom("GET", "POST", "HEAD"), { nil: undefined }),
          url: fc.oneof(
            fc.string(),
            fc.constantFrom("http://", "//", "http://[", "\\", "/w/ws-1/?x=1", ""),
          ),
          accept: fc.option(fc.string(), { nil: undefined }),
          dest: fc.option(fc.constantFrom("document", "empty", "script"), { nil: undefined }),
          cookie: fc.option(fc.string(), { nil: undefined }),
        }),
        ({ method, url, accept, dest, cookie }) => {
          const result = editorTokenRedirect(
            { method, url, headers: { accept, "sec-fetch-dest": dest, cookie } },
            WS,
          );
          expect(result === undefined || typeof result === "string").toBe(true);
        },
      ),
    );
  });
});
