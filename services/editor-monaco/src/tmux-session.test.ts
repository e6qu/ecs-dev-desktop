// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { tmuxSessionName } from "./terminal";

describe("tmux session naming decides what a reopened tab rejoins", () => {
  it("gives each plain tab its own shell, not a view of a shared one", () => {
    // `new-session -A` attaches when the name exists, so a shared name made two
    // terminal tabs two views of one shell -- typing in one appeared in the
    // other. A new tab means a new shell.
    const a = tmuxSessionName(undefined);
    const b = tmuxSessionName(undefined);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^edd-sh-[0-9a-f]+$/);
  });

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
