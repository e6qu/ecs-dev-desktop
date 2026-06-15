<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/images

Curated **golden workspace images**: OpenVSCode Server, OpenSSH `sshd` + our SSH
CA trust, the idle-agent, the git-credential broker, and a non-root `workspace`
user, plus language toolchains. They are published to ECR and surfaced in the admin
catalog (the base-image allow-list). Extensions are sourced from **Open VSX** (not
the MS marketplace).

## A collection built on a shared base

| Image          | Dir                           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Size    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **base**       | [`base/`](./base)             | Common runtime: OpenVSCode Server, `sshd` + CA, idle-agent, entrypoint, git-credential helper, `workspace` user, **Node 22**; the user-CLI setup (npm global prefix in `$HOME` + PATH across the shell matrix) + Dark-mode default; the **AI coding agents** (Claude Code + Codex extensions, the `claude` CLI); cross-cutting JS/TS tooling matching CI (prettier, eslint, knip, jscpd + the prettier/eslint/GitHub extensions); and the cross-cutting **Trivy** security scanner (matches the repo CI gate). **No language compilers/toolchains.** Every variant builds `FROM` this. | ~1.8 GB |
| **omnibus**    | [`omnibus/`](./omnibus)       | base **+ every language toolchain** (C/C++, Go, Java JDK+Maven+Gradle, Rust, Python 3 + uv, yarn/pnpm/bun, Playwright) **+ every language's linters/SAST** (ruff/ty/vulture/bandit/semgrep; golangci-lint + staticcheck + deadcode + dupl; clippy/rustfmt + cargo-audit) + all the language extensions.                                                                                                                                                                                                                                                                                | ~5.9 GB |
| **typescript** | [`typescript/`](./typescript) | base + yarn/pnpm/bun + `tsc` + build-essential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~2.2 GB |
| **python**     | [`python/`](./python)         | base + Python 3 + uv + ruff/ty/vulture/bandit/semgrep + Python/Ruff/ty/basedpyright/Semgrep extensions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ~3.6 GB |
| **go**         | [`go/`](./go)                 | base + Go + golangci-lint + staticcheck + deadcode + dupl + the Go extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ~2.4 GB |
| **java**       | [`java/`](./java)             | base + JDK + Maven + Gradle + the Java extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ~2.6 GB |
| **rust**       | [`rust/`](./rust)             | base + rustup/cargo + clippy/rustfmt + cargo-audit + rust-analyzer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ~2.7 GB |

> Size note: the baked AI-agent extensions (Claude Code + Codex bundle native
> binaries, ~1 GB) live in **base**, so every variant carries them — that's the
> cost of "agents everywhere." If image size becomes a concern, the agents could be
> moved to omnibus-only or made an opt-in build arg.

> Dev tooling (#95): each language ships a curated lint/format/type-check/dead-code/
> SAST set so a workspace matches CI out of the box — **cross-cutting** prettier,
> eslint, knip, jscpd, and Trivy (base, every variant); **Python** ruff, ty, vulture,
> bandit, semgrep; **Go** golangci-lint, staticcheck, deadcode, dupl; **Rust** clippy,
> rustfmt, cargo-audit. CLIs install to system paths (not the EBS-shadowed `$HOME`) so
> they survive the home mount and stay on PATH for every shell. Remaining gap: **Java**
> ships the JDK/Maven/Gradle + the `redhat.java` extension but no standalone formatter/
> linter CLI (e.g. google-java-format) yet — a follow-up.

The variants are smoke-tested by `packages/e2e/src/image-variants.e2e.ts` (each
ships its toolchain + dev tooling + the shared base behaviour + seeded agent
extensions, and carries no other language); the omnibus by
`workspace-toolchain.e2e.ts`. Built and run by the path-gated `golden-images` CI
workflow (variants) / the `e2e` job (omnibus).

Build the base first, then a variant `FROM` it via the `BASE` build-arg:

```sh
docker build -t edd-base infra/images/base
docker build --build-arg BASE=edd-base -t edd-workspace infra/images/omnibus
```

The e2e/live suites launch the **omnibus** image (tagged `edd-workspace:e2e`).

## Runtime behaviour (shared, from `base`)

At startup the entrypoint writes the injected workspace SSH CA public key and the
`dev-<workspaceId>` principal file, starts `sshd`, seeds default editor settings
(Dark mode, write-if-absent on the EBS home volume), then runs the idle-agent and
OpenVSCode Server as the non-root `workspace` user (via `gosu`).

The default extensions (AI agents + dev extensions) are installed into OpenVSCode's
**built-in** extensions dir at image build (`/opt/openvscode-server/extensions`), so
they load read-only with no runtime copy and survive the volume mount; the user's own
extensions still install into the volume's extensions dir and persist across restarts.

Cross-cutting notes:

- **`$HOME` is the EBS mount** (`/home/workspace`). Anything baked there at build
  time is shadowed by the volume at runtime, so home-resident defaults (editor
  settings, the npm global prefix dir) are seeded **at first boot** or kept in a
  system path. Variants that run their own system `npm install -g` at build must
  override the npm prefix back to `/usr/local` for that step (the base sets a
  home prefix via `NPM_CONFIG_PREFIX`, which is inherited).
- **PATH for user-installed CLIs** (`~/.npm-global/bin`, `~/.local/bin`) is set in
  three places so every shell sees it: image `ENV` (non-login `bash -c`),
  `/etc/profile.d/edd-path.sh` (login terminal), and an sshd `SetEnv` drop-in
  under `/etc/ssh/sshd_config.d/` (the `ssh host '<cmd>'` exec channel). Variants
  overwrite the profile.d + sshd drop-ins to add their toolchain dirs.

The golden-image SSH path is covered against the AWS container-mode simulator:
`EcsComputeProvider` launches the image with managed EBS, the task exposes its
awsvpc private IP, and a same-VPC client task connects with a CA-signed OpenSSH
certificate. Image publication to the Terraform-created ECR repositories and real
deploy scanning remain AWS-gated.
