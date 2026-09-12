// SPDX-License-Identifier: AGPL-3.0-or-later
// The session registry ships as a standalone script in the workspace image
// (infra/images/base/edd-session.mjs); these cover the decisions the UI will
// later trust, without needing a tmux server in CI.
import { describe, expect, it } from "vitest";

import { liveSessions, resumeCommandFor } from "../../../infra/images/base/edd-session.mjs";

describe("resume commands are data, not guesses at the call site", () => {
  it("knows the agents the image ships", () => {
    expect(resumeCommandFor("claude")).toBe("claude --continue");
    expect(resumeCommandFor("claude --resume foo")).toBe("claude --continue");
    expect(resumeCommandFor("codex")).toBe("codex resume --last");
    expect(resumeCommandFor("/usr/local/bin/codex")).toBe("codex resume --last");
  });

  it("says nothing for a command with no documented resume, rather than inventing one", () => {
    // Staging a wrong flag would fail in the user's terminal at the moment they
    // pressed Enter, which is the worst place to find out.
    expect(resumeCommandFor("bash")).toBeNull();
    expect(resumeCommandFor("shell")).toBeNull();
  });
});

describe("a missing tmux server is a normal state, not a failure", () => {
  it("reports no live sessions when tmux is not running", () => {
    // A freshly booted task has no tmux server until the first terminal opens.
    // Treating that as an error would fail the boot reconcile every cold start.
    const noServer = () => ({ status: 1, stdout: "", stderr: "no server running" });
    expect(liveSessions(noServer).size).toBe(0);
  });

  it("reads the names tmux reports", () => {
    const listing = () => ({ status: 0, stdout: "edd\nedd-claude\n\nedd-codex\n", stderr: "" });
    expect([...liveSessions(listing)].sort()).toEqual(["edd", "edd-claude", "edd-codex"]);
  });
});
