// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import liveConfig from "../playwright.live.config";
import portalConfig from "../playwright.config";
import { immutableReleaseEnvironment } from "./release-env";

function webServerEnvironment(config: { webServer?: unknown }): Record<string, unknown> {
  const webServer = config.webServer;
  if (webServer === undefined || Array.isArray(webServer) || typeof webServer !== "object") {
    throw new Error("expected one Playwright web server");
  }
  if (!("env" in webServer)) {
    throw new Error("expected the Playwright web server to declare its release environment");
  }
  const environment = webServer.env;
  if (environment === null || typeof environment !== "object") {
    throw new Error("expected the Playwright web server to declare its release environment");
  }
  return environment as Record<string, unknown>;
}

describe("production Playwright web servers", () => {
  const expectedReleaseEnvironment = immutableReleaseEnvironment(process.env);

  it.each([
    ["portal", portalConfig],
    ["live ECS", liveConfig],
  ])("starts the %s server with immutable release provenance", (_name, config) => {
    expect(webServerEnvironment(config)).toMatchObject(expectedReleaseEnvironment);
  });
});
