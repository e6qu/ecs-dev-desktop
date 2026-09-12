// SPDX-License-Identifier: AGPL-3.0-or-later
// The session registry ships as a standalone script in the workspace image
// (infra/images/base/edd-session.mjs); these cover the decisions the UI will
// later trust, without needing a tmux server in CI.
import { describe, expect, it } from "vitest";

import { liveSessions, resumeCommandFor, waitForShell } from "../../../infra/images/base/edd-session.mjs";

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

describe("restore waits for a shell before staging a resume command", () => {
  it("gives up rather than staging into a pane with no shell", () => {
    // send-keys delivered before the shell draws its prompt is silently dropped:
    // the staged command vanishes and the user sees an empty terminal with no
    // hint anything was meant to be there. Observed for real on the first run.
    const noShell = () => ({ status: 0, stdout: "node\n", stderr: "" });
    expect(waitForShell("edd-claude", noShell, 2, 1)).toBe(false);
  });

  it("proceeds as soon as a pane reports a shell", () => {
    const withShell = () => ({ status: 0, stdout: "zsh\n", stderr: "" });
    expect(waitForShell("edd-claude", withShell, 2, 1)).toBe(true);
  });

  it("keeps waiting while tmux cannot answer yet", () => {
    let calls = 0;
    const slow = () => {
      calls += 1;
      return calls < 2 ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "bash\n", stderr: "" };
    };
    expect(waitForShell("edd-claude", slow, 5, 1)).toBe(true);
  });
});
