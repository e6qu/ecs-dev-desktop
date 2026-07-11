// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMAGE_ROLLOUT_BASE_DEADLINE_MS,
  IMAGE_ROLLOUT_HARD_CAP_MS,
  type WaitClock,
  chooseEnabledImage,
  sweepSmokeWorkspaces,
  waitEnabledImage,
  waitReady,
  waitTerminated,
} from "./deployed-workspace-smoke-lib";

const BASE_URL = "https://app.smoke.example";
const EXPECTED_TAG = "5d46f4b63d6d";
const EXPECTED_IMAGE = `123456789012.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:${EXPECTED_TAG}`;
const MINUTE_MS = 60 * 1000;

/**
 * Virtual clock (AGENTS.md §6.10): `sleep` advances virtual time instantly, so
 * multi-minute polling deadlines run in milliseconds and never touch the wall
 * clock.
 */
function virtualClock(): WaitClock & { readonly elapsed: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    elapsed: () => t,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FakeDeployedApp {
  readonly imageSource: () => unknown;
  readonly baseImages: () => unknown;
  /** HTTP status to serve instead of a body; a body is served when undefined. */
  readonly httpStatus?: () => number | undefined;
}

/** Serve the two catalog endpoints waitEnabledImage polls, from a fake app. */
function stubCatalogFetch(app: FakeDeployedApp): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      const overrideStatus = app.httpStatus?.();
      if (overrideStatus !== undefined) {
        return Promise.resolve(jsonResponse({ error: "injected" }, overrideStatus));
      }
      if (url.pathname === "/api/admin/image-source") {
        return Promise.resolve(jsonResponse(app.imageSource()));
      }
      if (url.pathname === "/api/base-images") {
        return Promise.resolve(jsonResponse(app.baseImages()));
      }
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    }),
  );
}

function trigger(status: string, overrides: Record<string, string> = {}): unknown {
  return {
    id: "trig-1",
    afterSha: `${EXPECTED_TAG}0000000000000000000000000000`,
    tag: EXPECTED_TAG,
    decision: "build",
    status,
    target: "golden",
    ...overrides,
  };
}

function enabledCatalog(images: readonly string[]): unknown {
  return { baseImages: images.map((image) => ({ image, enabled: true })) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chooseEnabledImage", () => {
  it("selects the enabled image with the expected release tag", () => {
    expect(
      chooseEnabledImage(
        [
          "729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:oldtag",
          "729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:5d46f4b63d6d",
        ],
        "5d46f4b63d6d",
      ),
    ).toBe("729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:5d46f4b63d6d");
  });

  it("fails loudly instead of selecting a stale image when the expected tag is absent", () => {
    expect(() =>
      chooseEnabledImage(
        ["729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:e6b87475c1df"],
        "5d46f4b63d6d",
      ),
    ).toThrow(/no enabled base image with expected tag 5d46f4b63d6d/);
  });
});

describe("waitEnabledImage", () => {
  it("fails after the short base deadline when no matching trigger is active", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ repo: "e6qu/edd", branch: "main", triggers: [] }),
      baseImages: () => enabledCatalog(["registry/edd/golden/omnibus:stale"]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /did not roll to expected tag 5d46f4b63d6d/,
    );
    expect(clock.elapsed()).toBeGreaterThanOrEqual(IMAGE_ROLLOUT_BASE_DEADLINE_MS);
    expect(clock.elapsed()).toBeLessThan(IMAGE_ROLLOUT_BASE_DEADLINE_MS + MINUTE_MS);
  });

  it("keeps waiting past the base deadline while a matching build is in flight, then succeeds", async () => {
    const clock = virtualClock();
    const buildDurationMs = 12 * MINUTE_MS; // realistic golden-images build time
    stubCatalogFetch({
      imageSource: () => ({
        repo: "e6qu/edd",
        branch: "main",
        triggers: [trigger(clock.now() < buildDurationMs ? "building" : "succeeded")],
      }),
      baseImages: () =>
        clock.now() < buildDurationMs
          ? enabledCatalog(["registry/edd/golden/omnibus:stale"])
          : enabledCatalog(["registry/edd/golden/omnibus:stale", EXPECTED_IMAGE]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).resolves.toBe(
      EXPECTED_IMAGE,
    );
    expect(clock.elapsed()).toBeGreaterThanOrEqual(buildDurationMs);
  });

  it("matches an in-flight trigger by afterSha prefix when tag is absent", async () => {
    const clock = virtualClock();
    const buildDurationMs = 10 * MINUTE_MS;
    stubCatalogFetch({
      imageSource: () => ({
        triggers: [
          trigger(clock.now() < buildDurationMs ? "building" : "succeeded", { tag: "unrelated" }),
        ],
      }),
      baseImages: () =>
        clock.now() < buildDurationMs ? enabledCatalog([]) : enabledCatalog([EXPECTED_IMAGE]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).resolves.toBe(
      EXPECTED_IMAGE,
    );
  });

  it("never waits past the hard cap even while a trigger stays building", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [trigger("building")] }),
      baseImages: () => enabledCatalog([]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /did not roll to expected tag/,
    );
    expect(clock.elapsed()).toBeGreaterThanOrEqual(IMAGE_ROLLOUT_HARD_CAP_MS);
    expect(clock.elapsed()).toBeLessThan(IMAGE_ROLLOUT_HARD_CAP_MS + MINUTE_MS);
  });

  it.each(["failed", "error", "cancelled"])(
    "fails fast when the matching trigger reaches terminal status %s",
    async (status) => {
      const clock = virtualClock();
      stubCatalogFetch({
        imageSource: () => ({ triggers: [trigger(status)] }),
        baseImages: () => enabledCatalog([]),
      });
      await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
        new RegExp(`reached terminal status ${status}.*"status":"${status}"`, "s"),
      );
      expect(clock.elapsed()).toBeLessThan(MINUTE_MS);
    },
  );

  it("fails loudly and immediately when the image-source payload shape drifted", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ unexpected: true }),
      baseImages: () => enabledCatalog([]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /image-source payload did not contain a recognizable triggers array.*"unexpected":true/s,
    );
    expect(clock.elapsed()).toBe(0);
  });

  it("fails loudly and immediately when a trigger entry has no status", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [{ tag: EXPECTED_TAG }] }),
      baseImages: () => enabledCatalog([]),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /image-source trigger entry was not a recognizable trigger object/,
    );
    expect(clock.elapsed()).toBe(0);
  });

  it("throws immediately on a non-transient 4xx", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [] }),
      baseImages: () => enabledCatalog([]),
      httpStatus: () => 400,
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /400 \(will not self-heal\)/,
    );
    expect(clock.elapsed()).toBe(0);
  });

  it("polls through transient 5xx responses and reports the last HTTP status on timeout", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [] }),
      baseImages: () => enabledCatalog([]),
      httpStatus: () => 503,
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /last HTTP status: 503/,
    );
    expect(clock.elapsed()).toBeGreaterThanOrEqual(IMAGE_ROLLOUT_BASE_DEADLINE_MS);
  });

  it("recovers when a transient 5xx clears before the deadline", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [] }),
      baseImages: () => enabledCatalog([EXPECTED_IMAGE]),
      httpStatus: () => (clock.now() < MINUTE_MS ? 502 : undefined),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).resolves.toBe(
      EXPECTED_IMAGE,
    );
  });

  it("throws immediately on 401/403 (auth will not self-heal)", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [] }),
      baseImages: () => enabledCatalog([]),
      httpStatus: () => 403,
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /403 \(auth will not self-heal\)/,
    );
    expect(clock.elapsed()).toBe(0);
  });

  it("throws a shape error when /api/base-images has no baseImages array", async () => {
    const clock = virtualClock();
    stubCatalogFetch({
      imageSource: () => ({ triggers: [] }),
      baseImages: () => ({ items: [] }),
    });
    await expect(waitEnabledImage(BASE_URL, [], EXPECTED_TAG, undefined, clock)).rejects.toThrow(
      /\/api\/base-images payload did not contain a baseImages array/,
    );
    expect(clock.elapsed()).toBe(0);
  });
});

/** Route-level fetch stub: the handler decides the response per method+path. */
function stubRouteFetch(handler: (method: string, pathname: string) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      return Promise.resolve(handler(method, url.pathname));
    }),
  );
}

describe("waitReady", () => {
  it("polls through a transient 5xx and returns once the workspace reports ready", async () => {
    const clock = virtualClock();
    stubRouteFetch((method, pathname) => {
      expect(`${method} ${pathname}`).toBe("GET /api/workspaces/ws-1");
      if (clock.now() < MINUTE_MS) return jsonResponse({ error: "bad gateway" }, 502);
      return jsonResponse({ state: "running", functional: "ok" });
    });
    await expect(waitReady(BASE_URL, [], "ws-1", clock)).resolves.toBeUndefined();
    expect(clock.elapsed()).toBeGreaterThanOrEqual(MINUTE_MS);
  });

  it("polls through a 404 (create read-after-write lag) instead of aborting", async () => {
    const clock = virtualClock();
    stubRouteFetch(() =>
      clock.now() < 10_000
        ? jsonResponse({ error: "not found" }, 404)
        : jsonResponse({ state: "running", functional: "ok" }),
    );
    await expect(waitReady(BASE_URL, [], "ws-1", clock)).resolves.toBeUndefined();
  });

  it("throws immediately on a non-transient 4xx", async () => {
    const clock = virtualClock();
    stubRouteFetch(() => jsonResponse({ error: "bad request" }, 400));
    await expect(waitReady(BASE_URL, [], "ws-1", clock)).rejects.toThrow(
      /400 \(will not self-heal\)/,
    );
    expect(clock.elapsed()).toBe(0);
  });
});

describe("waitTerminated", () => {
  it("treats 404 as already terminated", async () => {
    const clock = virtualClock();
    stubRouteFetch(() => jsonResponse({ error: "gone" }, 404));
    await expect(waitTerminated(BASE_URL, [], "ws-1", clock)).resolves.toBeUndefined();
    expect(clock.elapsed()).toBe(0);
  });

  it("polls through transient 5xx until the workspace reports terminated", async () => {
    const clock = virtualClock();
    stubRouteFetch(() =>
      clock.now() < MINUTE_MS
        ? jsonResponse({ error: "unavailable" }, 503)
        : jsonResponse({ state: "terminated" }),
    );
    await expect(waitTerminated(BASE_URL, [], "ws-1", clock)).resolves.toBeUndefined();
  });
});

describe("sweepSmokeWorkspaces", () => {
  it("deletes only smoke-owned leftovers, best-effort per workspace", async () => {
    const clock = virtualClock();
    const deleted: string[] = [];
    const purged: string[] = [];
    stubRouteFetch((method, pathname) => {
      if (method === "GET" && pathname === "/api/workspaces") {
        return jsonResponse({
          workspaces: [
            { id: "ws-a", ownerId: "smoke-shot-11111111" },
            { id: "ws-b", ownerId: "smoke-22222222" },
            { id: "ws-c", ownerId: "alice" },
          ],
        });
      }
      if (method === "DELETE" && pathname === "/api/workspaces/ws-a") {
        deleted.push("ws-a");
        return new Response(null, { status: 202 });
      }
      // ws-b's delete keeps failing: its chain must fail without aborting ws-a's.
      if (method === "DELETE" && pathname === "/api/workspaces/ws-b") {
        return jsonResponse({ error: "boom" }, 500);
      }
      if (method === "GET" && pathname === "/api/workspaces/ws-a") {
        return jsonResponse({ error: "gone" }, 404);
      }
      if (method === "POST" && pathname === "/api/workspaces/ws-a/purge") {
        purged.push("ws-a");
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${pathname}`);
    });
    const result = await sweepSmokeWorkspaces(BASE_URL, [], undefined, clock);
    expect(result.swept).toEqual(["ws-a"]);
    expect(deleted).toEqual(["ws-a"]);
    expect(purged).toEqual(["ws-a"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toMatch(/ws-b \(owner smoke-22222222\) failed/);
  });

  it("fails loudly when the workspaces payload shape drifted", async () => {
    const clock = virtualClock();
    stubRouteFetch(() => jsonResponse({ items: [] }));
    await expect(sweepSmokeWorkspaces(BASE_URL, [], undefined, clock)).rejects.toThrow(
      /\/api\/workspaces payload did not contain a workspaces array/,
    );
  });
});
