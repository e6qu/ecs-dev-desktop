// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the slim per-language golden variants (typescript/python/go/java/rust):
// each ships its OWN language toolchain + the shared base behaviour (user-CLI npm
// prefix, PATH across shells, Dark-mode default) AND is genuinely slim (it does NOT
// carry the other languages). Variants are built FROM the base image by CI (the
// golden-images workflow) / `infra/images/<variant>`; this runs them prebuilt as
// `edd-ws-<variant>:e2e`.
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

interface Variant {
  readonly name: string;
  readonly image: string;
  /** Commands that must succeed (the variant's toolchain + dev tooling is present). */
  readonly present: readonly string[];
  /** Executables that must be ABSENT (proves the variant is slim, not omnibus). */
  readonly absent: readonly string[];
  /** VS Code extension ids that must be seeded on first boot (beyond the base/agent set). */
  readonly extensions: readonly string[];
}

const VARIANTS: readonly Variant[] = [
  {
    name: "typescript",
    image: process.env.IMG_TYPESCRIPT ?? "edd-ws-typescript:e2e",
    present: ["tsc --version", "yarn --version", "pnpm --version", "bun --version"],
    absent: ["go", "cargo", "javac"],
    extensions: [], // base already seeds prettier + eslint
  },
  {
    name: "python",
    image: process.env.IMG_PYTHON ?? "edd-ws-python:e2e",
    // `command -v semgrep` rather than `semgrep --version`: semgrep-core SIGILLs on
    // some arm64 hosts (it runs fine on CI amd64); this still proves it's installed.
    present: ["python3 --version", "uv --version", "ruff --version", "command -v semgrep"],
    absent: ["go", "cargo", "javac"],
    extensions: ["ms-python.python", "charliermarsh.ruff"],
  },
  {
    name: "go",
    image: process.env.IMG_GO ?? "edd-ws-go:e2e",
    // golangci-lint (meta-linter) + staticcheck (static analysis) + deadcode +
    // dupl (CPD) — #95's Go dev-tooling set. deadcode/dupl have no `--version`
    // (their no-arg form exits non-zero), so prove them via `command -v`.
    present: [
      "go version",
      "golangci-lint --version",
      "staticcheck --version",
      "command -v deadcode",
      "command -v dupl",
    ],
    absent: ["cargo", "javac", "uv"],
    extensions: ["golang.go"],
  },
  {
    name: "java",
    image: process.env.IMG_JAVA ?? "edd-ws-java:e2e",
    // JDK + Maven + Gradle + google-java-format (the formatter — #95 follow-up).
    present: ["java -version", "mvn -v", "gradle --version", "google-java-format --version"],
    absent: ["go", "cargo", "uv"],
    extensions: ["redhat.java"],
  },
  {
    name: "rust",
    image: process.env.IMG_RUST ?? "edd-ws-rust:e2e",
    // clippy (lint) + rustfmt (via the component) + cargo-audit (SCA/security, #95).
    present: [
      "cargo --version",
      "rustc --version",
      "cargo clippy --version",
      "cargo audit --version",
    ],
    absent: ["go", "javac", "uv"],
    extensions: ["rust-lang.rust-analyzer"],
  },
];

/** Whether a local Docker image exists. */
function imageExists(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Self-gating: the variant images are built only by the path-gated `golden-images`
// CI workflow (and locally). The default `pnpm test:e2e` (main `e2e` job) runs the
// whole *.e2e.ts glob but does NOT build these images, so skip there instead of
// failing on a missing image. Present (golden-images / local build) → run.
const HAVE_VARIANT_IMAGES = VARIANTS.every((v) => imageExists(v.image));
if (!HAVE_VARIANT_IMAGES) {
  console.warn(
    "image-variants.e2e: variant images not built — skipping (run via the golden-images workflow or build infra/images/<variant>)",
  );
}

describe.skipIf(!HAVE_VARIANT_IMAGES)(
  "golden workspace language variants (slim, FROM base)",
  { timeout: 120_000 },
  () => {
    let container = "";

    afterEach(() => {
      if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      container = "";
    });

    /** Run a login-shell command as the `workspace` user in the running container. */
    const sh = (cmd: string): string =>
      execFileSync("docker", ["exec", "-u", "workspace", container, "bash", "-lc", cmd], {
        encoding: "utf8",
      });

    describe.each(VARIANTS)("$name variant", (v) => {
      function start(): void {
        container = `edd-variant-${v.name}`;
        execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
        execFileSync("docker", [
          "run",
          "-d",
          "--name",
          container,
          "-e",
          `EDD_WORKSPACE_ID=ws-${v.name}`,
          "-e",
          "EDD_CONTROL_PLANE_URL=http://127.0.0.1:9",
          "-e",
          "EDD_AGENT_TOKEN=t",
          "-e",
          "CONNECTION_TOKEN=t",
          v.image,
        ]);
        execFileSync("docker", ["exec", container, "bash", "-c", "sleep 2"]);
      }

      it("ships its toolchain, keeps the shared base behaviour, and stays slim", () => {
        start();

        // The variant's own toolchain is present (each command exits 0 with output).
        for (const cmd of v.present) {
          const out = sh(`${cmd} 2>&1`);
          expect(out.trim().length, `${v.name}: \`${cmd}\` produced no output`).toBeGreaterThan(0);
        }

        // Slim: the other languages are NOT installed.
        for (const bin of v.absent) {
          const probe = sh(
            `command -v ${bin} >/dev/null 2>&1 && echo PRESENT || echo ABSENT`,
          ).trim();
          expect(probe, `${v.name}: expected \`${bin}\` to be absent`).toBe("ABSENT");
        }

        // Extensions: the cross-cutting dev extensions from base (e.g. prettier) plus
        // this variant's own language extensions (#95), in OpenVSCode's built-in dir.
        const builtin = sh("ls /opt/openvscode-server/extensions 2>&1");
        expect(builtin).toContain("esbenp.prettier-vscode");
        for (const ext of v.extensions) {
          expect(builtin, `${v.name}: extension ${ext} not baked in`).toContain(ext);
        }

        // AI coding agents (Claude Code + Codex) live in base, so every variant --
        // slim or omnibus -- carries both CLIs and their VS Code extensions.
        const claude = sh(
          "command -v claude >/dev/null 2>&1 && echo PRESENT || echo ABSENT",
        ).trim();
        expect(claude, `${v.name}: agent CLI should be in every variant`).toBe("PRESENT");
        const codex = sh("command -v codex >/dev/null 2>&1 && echo PRESENT || echo ABSENT").trim();
        expect(codex, `${v.name}: agent CLI should be in every variant`).toBe("PRESENT");
        expect(builtin, `${v.name}: agent extension should be in every variant`).toContain(
          "anthropic.claude-code",
        );
        expect(builtin, `${v.name}: agent extension should be in every variant`).toContain(
          "openai.chatgpt",
        );

        // Privilege guard (base): a tool needing privileges the sandbox doesn't grant
        // (docker, sudo, …) is BLOCKED + warned + recorded, not silently run. The
        // wrapper sits ahead of any real binary on PATH and exits 126.
        const guarded = sh("docker ps 2>&1; echo EXIT=$?").trim();
        expect(guarded, `${v.name}: docker should be privilege-guarded`).toContain(
          "not available in this workspace",
        );
        expect(guarded, `${v.name}: guard should emit a structured security line`).toContain(
          "privilege_attempt",
        );
        expect(guarded, `${v.name}: guard should block (exit 126)`).toContain("EXIT=126");

        // Shared base behaviour: Node (base), the cross-cutting Trivy security
        // scanner (#95, from base — every variant inherits it), a user-writable npm
        // global prefix (#90), user-CLI dirs on PATH (#91), and Dark mode (#94).
        expect(sh("node --version 2>&1")).toMatch(/v\d+\./);
        expect(sh("trivy --version 2>&1")).toMatch(/Version: \d+\./);
        const prefix = sh(
          'p="$(npm config get prefix)"; mkdir -p "$p/bin" && touch "$p/bin/.probe" && echo "$p"',
        ).trim();
        expect(prefix).toContain("/home/workspace/.npm-global");
        expect(sh('echo "$PATH"')).toContain("/home/workspace/.npm-global/bin");
        expect(sh("cat ~/.openvscode-server/data/User/settings.json")).toContain(
          "Default Dark Modern",
        );
      });
    });
  },
);
