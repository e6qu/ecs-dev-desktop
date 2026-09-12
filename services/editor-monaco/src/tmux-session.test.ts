// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { tmuxSessionName } from "./terminal";

describe("tmux session naming decides what a reopened tab rejoins", () => {
  it("shares one session for plain shells", () => {
    expect(tmuxSessionName(undefined)).toBe("edd");
  });

  it("gives each agent command its own session, so two agents are not the same shell", () => {
    expect(tmuxSessionName("claude")).toBe("edd-claude");
    expect(tmuxSessionName("codex")).toBe("edd-codex");
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
