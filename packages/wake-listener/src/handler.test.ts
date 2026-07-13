// SPDX-License-Identifier: AGPL-3.0-or-later
import { createLogger, fixedClock, type StructuredLogger } from "@edd/core";
import { describe, expect, it } from "vitest";

import { type EcsServicePort, type EcsServiceScale } from "./ecs-service";
import {
  handleWake,
  WAKE_ENV,
  WAKE_FORBIDDEN_STATUS,
  WAKE_TOKEN_HEADER,
  type WakeDeps,
} from "./handler";

const BASE_ENV = {
  [WAKE_ENV.cluster]: "edd-prod-workspaces",
  [WAKE_ENV.service]: "edd-prod-control-plane",
  [WAKE_ENV.activeDesired]: "2",
} as const;

interface SetDesiredCall {
  readonly cluster: string;
  readonly service: string;
  readonly desiredCount: number;
}

/** A fake ECS port: reports a fixed scale and records any UpdateService call. */
function fakeEcs(scale: EcsServiceScale, calls: SetDesiredCall[]): EcsServicePort {
  return {
    describe: () => Promise.resolve(scale),
    setDesiredCount: (input) => {
      calls.push(input);
      return Promise.resolve();
    },
  };
}

/** A fake ECS port whose describe fails loud. */
function failingEcs(): EcsServicePort {
  return {
    describe: () => Promise.reject(new Error("DescribeServices boom")),
    setDesiredCount: () => Promise.reject(new Error("unexpected UpdateService")),
  };
}

function silentLogger(): StructuredLogger {
  return createLogger({
    service: "wake-listener-test",
    clock: fixedClock("2026-07-11T00:00:00.000Z"),
    write: () => {
      /* discard */
    },
  });
}

function deps(ecs: EcsServicePort, env: Readonly<Record<string, string | undefined>>): WakeDeps {
  return { ecs, env, logger: silentLogger() };
}

describe("handleWake", () => {
  it("scales a zeroed service up to the active desired count and serves the reloading page", async () => {
    const calls: SetDesiredCall[] = [];
    const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
    const res = await handleWake({}, deps(ecs, BASE_ENV));

    expect(calls).toEqual([
      { cluster: "edd-prod-workspaces", service: "edd-prod-control-plane", desiredCount: 2 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-edd-wake-action"]).toBe("wake");
    expect(res.body).toContain("window.location.reload()");
  });

  it("does NOT call UpdateService when the service is already at desired (still serves the page)", async () => {
    const calls: SetDesiredCall[] = [];
    const ecs = fakeEcs({ desiredCount: 2, runningCount: 2 }, calls);
    const res = await handleWake({}, deps(ecs, BASE_ENV));

    expect(calls).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-edd-wake-action"]).toBe("hold");
    expect(res.body).toContain("<html");
  });

  it("uses the default active desired count when the env var is absent", async () => {
    const calls: SetDesiredCall[] = [];
    const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
    const { [WAKE_ENV.activeDesired]: _omit, ...envNoActive } = BASE_ENV;
    await handleWake({}, deps(ecs, envNoActive));
    // DEFAULT_CONTROL_PLANE_ACTIVE_DESIRED === 2.
    expect(calls[0]?.desiredCount).toBe(2);
  });

  it("does NOT return a raw 5xx when ECS is unreachable — keeps the browser retrying", async () => {
    // A DescribeServices error is caught and the reloading page (200) is served, so CloudFront's
    // 503 error handler can't swallow it and the browser keeps reloading until the app is back.
    const res = await handleWake({}, deps(failingEcs(), BASE_ENV));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-edd-wake-action"]).toBe("hold");
    expect(res.body).toContain("<html");
  });

  it("fails loud on a missing required env var", async () => {
    const calls: SetDesiredCall[] = [];
    const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
    const { [WAKE_ENV.service]: _omit, ...envNoService } = BASE_ENV;
    await expect(handleWake({}, deps(ecs, envNoService))).rejects.toThrow(/missing required env/);
    expect(calls).toEqual([]);
  });

  it("fails loud on a non-numeric active desired count", async () => {
    const calls: SetDesiredCall[] = [];
    const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
    const env = { ...BASE_ENV, [WAKE_ENV.activeDesired]: "lots" };
    await expect(handleWake({}, deps(ecs, env))).rejects.toThrow(/must be a positive integer/);
  });

  describe("shared-secret gate", () => {
    const TOKEN = "s3cr3t-wake-token";
    const gatedEnv = { ...BASE_ENV, [WAKE_ENV.token]: TOKEN } as const;

    it("wakes when the request carries the matching x-edd-wake-token header", async () => {
      const calls: SetDesiredCall[] = [];
      const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
      const res = await handleWake(
        { headers: { [WAKE_TOKEN_HEADER]: TOKEN } },
        deps(ecs, gatedEnv),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-edd-wake-action"]).toBe("wake");
      expect(calls).toHaveLength(1);
    });

    it("returns 403 and never touches ECS when the token header is missing", async () => {
      const calls: SetDesiredCall[] = [];
      const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
      const res = await handleWake({ headers: {} }, deps(ecs, gatedEnv));
      expect(res.statusCode).toBe(WAKE_FORBIDDEN_STATUS);
      expect(res.body).not.toContain("window.location.reload()");
      expect(calls).toEqual([]);
    });

    it("returns 403 when the token header does not match", async () => {
      const calls: SetDesiredCall[] = [];
      const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
      const res = await handleWake(
        { headers: { [WAKE_TOKEN_HEADER]: "wrong" } },
        deps(ecs, gatedEnv),
      );
      expect(res.statusCode).toBe(WAKE_FORBIDDEN_STATUS);
      expect(calls).toEqual([]);
    });

    it("does not gate when EDD_WAKE_TOKEN is unset (open Function URL)", async () => {
      const calls: SetDesiredCall[] = [];
      const ecs = fakeEcs({ desiredCount: 0, runningCount: 0 }, calls);
      const res = await handleWake({ headers: {} }, deps(ecs, BASE_ENV));
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });
});
