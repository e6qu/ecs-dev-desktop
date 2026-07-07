// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const url = "http://localhost/api/integrations/github/image-webhook";
const secret = "webhook-secret";
const delivery = "123e4567-e89b-42d3-a456-426614174000";

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": delivery,
      "x-github-event": "push",
      "x-hub-signature-256": signature(body),
      ...headers,
    },
    body,
  });
}

describe("github image webhook route", () => {
  beforeEach(() => {
    vi.stubEnv("EDD_IMAGE_SOURCE_REPO", "e6qu/ecs-dev-desktop");
    vi.stubEnv("EDD_IMAGE_SOURCE_BRANCH", "main");
    vi.stubEnv("EDD_IMAGE_SOURCE_WEBHOOK_SECRET", secret);
  });

  it("rejects malformed envelopes before payload parsing", async () => {
    const res = await POST(request("not json", { "x-github-event": "ping" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported event" });
  });

  it("rejects an invalid signature before payload parsing", async () => {
    const res = await POST(request("not json", { "x-hub-signature-256": "sha256=bad" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
  });

  it("ignores signed pushes for a different branch without touching CodeBuild", async () => {
    const body = JSON.stringify({
      ref: "refs/heads/feature",
      after: "abc",
      repository: { full_name: "e6qu/ecs-dev-desktop" },
      commits: [],
    });
    const res = await POST(request(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true, reason: "wrong repo or branch" });
  });
});
