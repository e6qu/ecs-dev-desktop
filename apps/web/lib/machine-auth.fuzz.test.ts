// SPDX-License-Identifier: AGPL-3.0-or-later
// checkMachineAuth is the non-interactive trust boundary (idle-agent heartbeat, SSH-gateway wake):
// it parses an attacker-controllable Authorization header before verifying a per-workspace HMAC.
// It MUST be total and fail-closed. (req.headers already holds an HTTP-valid string, so the header
// generator is restricted to valid header-value characters.)
import { deriveWorkspaceToken } from "@edd/core";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_SECRET_ENV, MACHINE_AUTH_HEADER } from "./constants";
import { checkAgentAuth } from "./machine-auth";

const ORIGINAL = process.env[AGENT_SECRET_ENV];
const setSecret = (secret: string | undefined): void => {
  if (secret === undefined) Reflect.deleteProperty(process.env, AGENT_SECRET_ENV);
  else process.env[AGENT_SECRET_ENV] = secret;
};
const reqWith = (header: string | null): Request =>
  new Request(
    "http://internal/heartbeat",
    header === null ? {} : { headers: { [MACHINE_AUTH_HEADER]: header } },
  );

const headerArb = fc.stringMatching(/^[A-Za-z0-9 ._:/+=-]*$/);
const hexSecret = fc
  .uint8Array({ minLength: 8, maxLength: 32 })
  .map((b) => Buffer.from(b).toString("hex"));

afterEach(() => {
  setSecret(ORIGINAL);
});

describe("checkAgentAuth (fuzz) — machine-auth boundary", () => {
  it("is total: any header + workspaceId + secret returns absent|invalid|valid, never throws", () => {
    fc.assert(
      fc.property(
        fc.option(headerArb, { nil: null }),
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        (header, wsId, secret) => {
          setSecret(secret);
          expect(["absent", "invalid", "valid"]).toContain(checkAgentAuth(reqWith(header), wsId));
        },
      ),
    );
  });

  it("no header → 'absent'; a present header with an unset/empty secret is never 'valid'", () => {
    fc.assert(
      fc.property(
        headerArb.filter((h) => h.length > 0),
        fc.string(),
        fc.constantFrom(undefined, ""),
        (header, wsId, secret) => {
          setSecret("configured");
          expect(checkAgentAuth(reqWith(null), wsId)).toBe("absent");
          setSecret(secret);
          expect(checkAgentAuth(reqWith(header), wsId)).not.toBe("valid");
        },
      ),
    );
  });

  it("malformed headers (no space / wrong scheme / empty candidate) → 'invalid'", () => {
    setSecret("configured");
    fc.assert(
      fc.property(fc.string(), (wsId) => {
        expect(checkAgentAuth(reqWith("noscheme"), wsId)).toBe("invalid");
        expect(checkAgentAuth(reqWith("Basic abc"), wsId)).toBe("invalid");
        expect(checkAgentAuth(reqWith("Bearer "), wsId)).toBe("invalid");
      }),
    );
  });

  it("soundness: a genuine Bearer token is 'valid' (scheme case-insensitive); any mutation is 'invalid'", () => {
    fc.assert(
      fc.property(
        hexSecret,
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom("Bearer", "bearer", "BEARER", "BeArEr"),
        (secret, wsId, scheme) => {
          setSecret(secret);
          const token = deriveWorkspaceToken(secret, wsId);
          expect(checkAgentAuth(reqWith(`${scheme} ${token}`), wsId)).toBe("valid");
          const mutated = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
          expect(checkAgentAuth(reqWith(`Bearer ${mutated}`), wsId)).toBe("invalid");
          expect(checkAgentAuth(reqWith(`Bearer ${token}`), `${wsId}x`)).toBe("invalid");
        },
      ),
    );
  });
});
