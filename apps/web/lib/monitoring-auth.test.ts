// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";

import { MONITORING_TOKEN_ENV } from "./constants";
import { checkMonitoringAuth } from "./machine-auth";

const TOKEN = "s".repeat(48);

function request(authorization?: string): Request {
  return new Request("https://app.edd.dev.e6qu.dev/api/observations", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

afterEach(() => {
  // Assigning undefined rather than `delete`: the env key is a computed name,
  // and Node treats an undefined assignment as an unset.
  process.env[MONITORING_TOKEN_ENV] = undefined;
});

describe("checkMonitoringAuth", () => {
  it("accepts the configured bearer", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request(`Bearer ${TOKEN}`))).toBe("valid");
  });

  it("accepts the scheme case-insensitively, as RFC 9110 requires", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request(`bearer ${TOKEN}`))).toBe("valid");
  });

  it("rejects a wrong token", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request(`Bearer ${"x".repeat(48)}`))).toBe("invalid");
  });

  it("rejects a token that is merely a prefix of the secret", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request(`Bearer ${TOKEN.slice(0, 20)}`))).toBe("invalid");
  });

  it("rejects another scheme", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request(`Basic ${TOKEN}`))).toBe("invalid");
  });

  it("reports an absent header as absent, not invalid", () => {
    process.env[MONITORING_TOKEN_ENV] = TOKEN;
    expect(checkMonitoringAuth(request())).toBe("absent");
  });

  // A deployment that forgot the secret must not become an open endpoint. The
  // observation carries fleet topology and cost, so failing open here would
  // publish it to anyone who asked.
  it("rejects every token when no secret is configured", () => {
    expect(checkMonitoringAuth(request(`Bearer ${TOKEN}`))).toBe("invalid");
    process.env[MONITORING_TOKEN_ENV] = "";
    expect(checkMonitoringAuth(request(`Bearer ${TOKEN}`))).toBe("invalid");
  });
});
