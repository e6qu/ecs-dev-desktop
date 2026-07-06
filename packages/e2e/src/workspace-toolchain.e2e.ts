// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the golden workspace image ships a working polyglot toolchain "out of
// the box": every requested language/tool is present AND can compile+run a
// hello-world (producing a real artifact) as the non-root `workspace` user over
// a login shell (the PATH the OpenVSCode terminal / SSH session actually get).
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";
const CONTAINER = "edd-toolchain-smoke";

/** Run a NON-login, NON-interactive command as `workspace` (the `bash -c` /
 * agent-subprocess shell — the one that historically missed user-CLI PATH). */
function shc(cmd: string): string {
  return execFileSync("docker", ["exec", "-u", "workspace", CONTAINER, "bash", "-c", cmd], {
    encoding: "utf8",
  });
}

/** Run a login-shell command in the workspace container as `workspace`. */
function sh(cmd: string): string {
  return execFileSync("docker", ["exec", "-u", "workspace", CONTAINER, "bash", "-lc", cmd], {
    encoding: "utf8",
  });
}

beforeAll(() => {
  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "EDD_WORKSPACE_ID=ws-toolchain",
    "-e",
    "EDD_CONTROL_PLANE_URL=http://127.0.0.1:9",
    "-e",
    "EDD_AGENT_TOKEN=t",
    "-e",
    "CONNECTION_TOKEN=t",
    IMAGE,
  ]);
  // The entrypoint sets up sshd then execs OpenVSCode; exec is available almost
  // immediately, but give the bg setup a moment.
  execFileSync("docker", ["exec", CONTAINER, "bash", "-c", "sleep 2"]);
}, 60_000);

afterAll(() => {
  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
});

describe("golden workspace polyglot toolchain (out of the box)", { timeout: 180_000 }, () => {
  it("ships the Node ecosystem: node, npm, yarn, pnpm, bun (offline, no corepack download)", () => {
    // None of these may print the corepack "about to download" notice (would
    // mean a no-egress workspace can't use them).
    const out = sh(
      'for t in node npm yarn pnpm bun; do echo "$t=$($t --version 2>&1 | tail -1)"; done',
    );
    expect(out).toMatch(/node=v22\./);
    expect(out).toMatch(/yarn=\d+\./);
    expect(out).toMatch(/pnpm=\d+\./);
    expect(out).toMatch(/bun=\d+\./);
    expect(out).not.toMatch(/Corepack is about to download/i);
  });

  it("compiles and runs C (gcc → ELF binary)", () => {
    const out = sh(
      'cd "$(mktemp -d)" && printf "#include <stdio.h>\\nint main(){puts(\\"C-OK\\");return 0;}\\n" > a.c ' +
        "&& gcc a.c -o a && ./a && od -An -tx1 -N4 a | tr -s ' '",
    );
    expect(out).toContain("C-OK");
    expect(out).toContain("7f 45 4c 46"); // ELF magic ⇒ a real compiled artifact
  });

  it("compiles and runs Go (go build → binary)", () => {
    const out = sh(
      'cd "$(mktemp -d)" && go mod init demo >/dev/null 2>&1 ' +
        '&& printf "package main\\nimport \\"fmt\\"\\nfunc main(){fmt.Println(\\"GO-OK\\")}\\n" > main.go ' +
        "&& go build -o app . && ./app",
    );
    expect(out).toContain("GO-OK");
  });

  it("compiles and runs Rust (rustc → binary)", () => {
    const out = sh(
      'cd "$(mktemp -d)" && printf "fn main(){println!(\\"RUST-OK\\");}\\n" > m.rs && rustc m.rs -o m && ./m',
    );
    expect(out).toContain("RUST-OK");
  });

  it("compiles and runs Java, and ships Maven + Gradle", () => {
    const out = sh(
      'cd "$(mktemp -d)" && printf "public class H{public static void main(String[] a){System.out.println(\\"JAVA-OK\\");}}\\n" > H.java ' +
        "&& javac H.java && java H && echo mvn=$(mvn -v 2>/dev/null | head -1) && echo gradle=$(gradle --version 2>/dev/null | grep -i '^Gradle')",
    );
    expect(out).toContain("JAVA-OK");
    // (Maven/Gradle banners may carry ANSI color codes — match the product name.)
    expect(out).toContain("Apache Maven");
    expect(out).toMatch(/Gradle \d+/);
  });

  it("runs Python and ships uv", () => {
    const out = sh('python3 -c "print(\\"PY-OK\\")" && echo uv=$(uv --version)');
    expect(out).toContain("PY-OK");
    expect(out).toMatch(/uv=uv \d+\./);
  });

  it("ships Playwright with a preinstalled browser", () => {
    // The browser binary lives under the shared PLAYWRIGHT_BROWSERS_PATH so the
    // workspace user can run tests without re-downloading.
    const out = sh("echo pw=$(playwright --version) && ls /ms-playwright | grep -ci chromium");
    expect(out).toMatch(/pw=Version \d+\./);
    expect(out.trim().split("\n").pop()).not.toBe("0"); // ≥1 chromium dir present
  });
});

// #90/#91/#94 — the non-root workspace user can install their own CLIs, those land
// on PATH across the shell matrix, and the editor defaults to Dark mode.
describe("golden workspace user-CLI + defaults", { timeout: 60_000 }, () => {
  it("points npm's global prefix at a user-writable HOME dir (so `npm install -g` won't EACCES) [#90]", () => {
    // Root cause of the EACCES was the root-owned /usr/local prefix. Prove the
    // prefix is now a HOME dir AND that the user can actually write under it
    // (deterministic, no network) — i.e. a global install would succeed.
    const out = sh(
      'p="$(npm config get prefix)"; echo "prefix=$p"; ' +
        'mkdir -p "$p/lib/node_modules" "$p/bin" && touch "$p/bin/.probe" && echo WRITABLE',
    );
    expect(out).toContain("prefix=/home/workspace/.npm-global");
    expect(out).toContain("WRITABLE");
  });

  it("puts user-CLI bin dirs on PATH for login AND non-login/non-interactive shells [#91]", () => {
    // Login shell (integrated terminal / interactive SSH) via /etc/profile.d:
    const login = sh('echo "$PATH"');
    expect(login).toContain("/home/workspace/.npm-global/bin");
    expect(login).toContain("/home/workspace/.local/bin");
    // Non-login, non-interactive (`bash -c`: agent subprocesses, tasks) via image ENV:
    const nonlogin = shc('echo "$PATH"');
    expect(nonlogin).toContain("/home/workspace/.npm-global/bin");
    expect(nonlogin).toContain("/home/workspace/.local/bin");
    // The SSH-exec channel (`ssh host '<cmd>'`) is covered by sshd `SetEnv PATH`
    // (verified in the ssh-gateway tier); assert sshd's EFFECTIVE config carries it
    // (it lives in a per-image drop-in under /etc/ssh/sshd_config.d/).
    const sshdCfg = execFileSync(
      "docker",
      ["exec", CONTAINER, "sh", "-c", "sshd -T 2>/dev/null | grep -i '^setenv '"],
      { encoding: "utf8" },
    );
    expect(sshdCfg).toContain("/home/workspace/.npm-global/bin");
  });

  it("defaults the editor to Dark mode, seeded write-if-absent on first boot [#94]", () => {
    const settings = sh("cat ~/.openvscode-server/data/User/settings.json");
    expect(settings).toContain("Default Dark Modern");
  });
});

// #93/#95 — every golden variant (base) ships the AI coding agents (CLI + seeded
// extensions) and omnibus adds a curated cross-language dev-tooling set on top.
describe("golden omnibus: AI agents + dev tooling", { timeout: 60_000 }, () => {
  it("ships the Claude Code + Codex agent CLIs and bakes in the agent extensions [#93]", () => {
    expect(sh("command -v claude")).toContain("claude");
    expect(sh("command -v codex")).toContain("codex");
    const builtin = sh("ls /opt/openvscode-server/extensions");
    expect(builtin).toContain("anthropic.claude-code");
    expect(builtin).toContain("openai.chatgpt");
  });

  it("ships curated linters/formatters/SAST across languages [#95]", () => {
    // Cross-cutting (Node + security, from base) + per-language (omnibus carries all).
    expect(sh("prettier --version 2>&1")).toMatch(/\d+\./);
    expect(sh("eslint --version 2>&1")).toMatch(/\d+\./);
    expect(sh("knip --version 2>&1")).toMatch(/\d+\./);
    expect(sh("ruff --version 2>&1")).toMatch(/ruff \d+\./);
    // `command -v` (not `semgrep --version`): semgrep-core SIGILLs on some arm64
    // hosts but runs on CI amd64; this proves it's installed + on PATH.
    expect(sh("command -v semgrep")).toContain("semgrep");
    // Cross-cutting security scanner from base (matches this repo's CI gate).
    expect(sh("trivy --version 2>&1")).toMatch(/Version: \d+\./);
    // Go: golangci-lint (meta-linter) + staticcheck + deadcode + dupl (#95).
    expect(sh("golangci-lint --version 2>&1")).toContain("golangci-lint");
    expect(sh("staticcheck --version 2>&1")).toContain("staticcheck");
    expect(sh("command -v deadcode")).toContain("deadcode");
    expect(sh("command -v dupl")).toContain("dupl");
    // Rust: clippy (lint) + cargo-audit (SCA/security, #95).
    expect(sh("cargo clippy --version 2>&1")).toContain("clippy");
    expect(sh("cargo audit --version 2>&1")).toMatch(/audit \d+\./);
    // Java: google-java-format (the formatter — #95 follow-up).
    expect(sh("google-java-format --version 2>&1")).toMatch(/\d+\./);
  });
});
