// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the golden workspace image ships a working polyglot toolchain "out of
// the box": every requested language/tool is present AND can compile+run a
// hello-world (producing a real artifact) as the non-root `workspace` user over
// a login shell (the PATH the OpenVSCode terminal / SSH session actually get).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";
const CONTAINER = "edd-toolchain-smoke";

/** Run a login-shell command in the workspace container as `workspace`. */
function sh(cmd: string): string {
  return execFileSync("docker", ["exec", "-u", "workspace", CONTAINER, "bash", "-lc", cmd], {
    encoding: "utf8",
  });
}

beforeAll(() => {
  const keyDir = mkdtempSync(join(tmpdir(), "edd-tc-ca-"));
  const caKey = join(keyDir, "ca");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", caKey, "-C", "edd-tc-ca"]);
  const caPub = readFileSync(`${caKey}.pub`, "utf8").trim();
  rmSync(keyDir, { recursive: true, force: true });

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
    `EDD_SSH_CA_PUBLIC_KEY=${caPub}`,
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
