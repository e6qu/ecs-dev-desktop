// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { tmuxSessionName } from "./terminal";

describe("tmux session naming decides what a reopened agent tab rejoins", () => {
  // Plain shells never reach this function: they spawn directly so that closing a
  // tab ends the shell rather than leaving one running for the life of the
  // workspace. Only agent tabs are routed through tmux, and only they persist.
  it("gives each agent command its own session, so two agents are not the same shell", () => {
    expect(tmuxSessionName("claude")).toBe("edd-claude");
    expect(tmuxSessionName("codex")).toBe("edd-codex");
    // Stable for agents: reopening rejoins the running session rather than
    // starting a second agent beside it.
    expect(tmuxSessionName("claude")).toBe(tmuxSessionName("claude  --resume"));
  });

  it("reduces the command to a name tmux can address", () => {
    // tmux reads `.` and `:` as session address syntax, so a name carrying them
    // would attach somewhere unintended rather than fail.
    expect(tmuxSessionName("/usr/local/bin/claude.sh")).not.toContain(".");
    expect(tmuxSessionName("a:b")).not.toContain(":");
    expect(tmuxSessionName("   ")).toBe("edd");
  });
});
