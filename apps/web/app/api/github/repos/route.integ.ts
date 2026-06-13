// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../../lib/constants";
import { GET, POST } from "./route";

/**
 * Auth + precondition paths of the GitHub repo routes (the GitHub-call happy
 * path is covered by the adapter unit tests). Verifies: unauthenticated → 401;
 * a viewer cannot create → 403; bad body → 400; and a caller with no connected
 * GitHub credential → 409 (here EDD_TOKEN_ENC_KEY is unset, so the feature is
 * off and no token can be resolved).
 */
const headers = (id: string, role: string): Record<string, string> => ({
  [USER_ID_HEADER]: id,
  [ROLE_HEADER]: role,
  "content-type": "application/json",
});

const base = "http://localhost/api/github/repos";

beforeAll(() => {
  process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
  process.env.EDD_TOKEN_ENC_KEY = ""; // git-credential feature off → 409 for connected-GitHub paths
});

afterAll(() => {
  process.env[DEV_AUTH_ENV] = "";
});

describe("GitHub repo routes (auth + preconditions)", () => {
  it("GET requires authentication → 401", async () => {
    const res = await GET(new Request(base));
    expect(res.status).toBe(401);
  });

  it("GET with no connected GitHub credential → 409", async () => {
    const res = await GET(new Request(base, { headers: headers("u1", "member") }));
    expect(res.status).toBe(409);
  });

  it("POST requires authentication → 401", async () => {
    const res = await POST(new Request(base, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("POST as a viewer (cannot create) → 403", async () => {
    const res = await POST(
      new Request(base, {
        method: "POST",
        headers: headers("v1", "viewer"),
        body: JSON.stringify({ owner: "v1", name: "x", private: true, isPersonal: true }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST with a malformed body → 400", async () => {
    const res = await POST(
      new Request(base, { method: "POST", headers: headers("u1", "member"), body: "{}" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST with a valid body but no connected GitHub → 409", async () => {
    const res = await POST(
      new Request(base, {
        method: "POST",
        headers: headers("u1", "member"),
        body: JSON.stringify({ owner: "u1", name: "demo", private: true, isPersonal: true }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
