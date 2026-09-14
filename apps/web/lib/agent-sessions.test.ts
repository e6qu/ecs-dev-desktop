// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AgentSessionDto } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import { orderSessions, presentSession, shortCwd } from "./agent-sessions";

const session = (over: Partial<AgentSessionDto>): AgentSessionDto => ({
  name: "edd-claude",
  cwd: "/data/home/work/app",
  command: "claude",
  resumeCommand: "claude --continue",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastSeenAt: "2026-09-13T10:05:00.000Z",
  status: "running",
  live: true,
  ...over,
});

describe("presentSession", () => {
  it("is running only while the workspace runs and tmux has the session", () => {
    expect(presentSession(session({}), "running")).toBe("running");
  });

  it("never claims a session is running inside a stopped workspace", () => {
    expect(presentSession(session({}), "stopped")).toBe("waiting");
    expect(presentSession(session({ status: "running", live: true }), "stopping")).toBe("waiting");
  });

  it("is waiting when the session is gone but can be resumed", () => {
    expect(presentSession(session({ live: false, status: "stopped" }), "running")).toBe("waiting");
    expect(presentSession(session({ live: false, status: "restored" }), "running")).toBe("waiting");
  });

  it("is ended when there is nothing to resume", () => {
    expect(presentSession(session({ live: false, resumeCommand: null }), "running")).toBe("ended");
    expect(presentSession(session({ resumeCommand: null }), "stopped")).toBe("ended");
  });
});

describe("shortCwd", () => {
  it("shows the project directory, not the whole volume path", () => {
    expect(shortCwd("/data/home/work/app")).toBe("app");
    expect(shortCwd("/data/home/work/app/")).toBe("app");
    expect(shortCwd("/")).toBe("/");
    expect(shortCwd("app")).toBe("app");
  });
});

describe("orderSessions", () => {
  it("puts running first, then waiting, then ended, newest-seen first within each", () => {
    const ended = session({ name: "ended", live: false, resumeCommand: null });
    const waitingOld = session({ name: "waiting-old", live: false, lastSeenAt: "2026-09-13T09:00:00.000Z" });
    const waitingNew = session({ name: "waiting-new", live: false, lastSeenAt: "2026-09-13T09:30:00.000Z" });
    const running = session({ name: "running" });
    expect(orderSessions([ended, waitingOld, running, waitingNew], "running").map((s) => s.name)).toEqual([
      "running",
      "waiting-new",
      "waiting-old",
      "ended",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [session({ name: "b", live: false }), session({ name: "a" })];
    orderSessions(input, "running");
    expect(input.map((s) => s.name)).toEqual(["b", "a"]);
  });
});
