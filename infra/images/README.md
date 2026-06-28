<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/images

Curated **golden workspace images**: OpenVSCode Server, OpenSSH `sshd` + its
registered-key authorizer, the idle-agent, the git-credential broker, and a
non-root `workspace` user, plus language toolchains. They are published to ECR
and surfaced in the admin catalog (the base-image allow-list). Extensions are
sourced from **Open VSX** (not the MS marketplace). SSH is **registered-key only**
— there is no CA and no certificates (see [`docs/architecture.md`](../../docs/architecture.md#ssh-registered-key-dual-trust)).

## A collection built on a shared base

| Image          | Dir                           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Size    |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **base**       | [`base/`](./base)             | Common runtime: OpenVSCode Server, `sshd` + CA, idle-agent, entrypoint, git-credential helper, `workspace` user, **Node 22**; the user-CLI setup (npm global prefix in `$HOME` + PATH across the shell matrix) + Dark-mode default; cross-cutting JS/TS tooling matching CI (prettier, eslint, knip, jscpd + the prettier/eslint/GitHub extensions); and the cross-cutting **Trivy** security scanner (matches the repo CI gate). **No language compilers/toolchains and no AI agents** (those are omnibus-only). Every variant builds `FROM` this. | ~0.8 GB |
| **omnibus**    | [`omnibus/`](./omnibus)       | base **+ the AI coding agents** (Claude Code + Codex extensions, the `claude` CLI) **+ every language toolchain** (C/C++, Go, Java JDK+Maven+Gradle, Rust, Python 3 + uv, yarn/pnpm/bun, Playwright) **+ every language's linters/SAST** (ruff/ty/vulture/bandit/semgrep; golangci-lint + staticcheck + deadcode + dupl; clippy/rustfmt + cargo-audit; google-java-format) + all the language extensions.                                                                                                                                           | ~5.9 GB |
| **typescript** | [`typescript/`](./typescript) | base + yarn/pnpm/bun + `tsc` + build-essential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~1.2 GB |
| **python**     | [`python/`](./python)         | base + Python 3 + uv + ruff/ty/vulture/bandit/semgrep + Python/Ruff/ty/basedpyright/Semgrep extensions.                                                                                                                                                                                                                                                                                                                                                                                                                                             | ~2.6 GB |
| **go**         | [`go/`](./go)                 | base + Go + golangci-lint + staticcheck + deadcode + dupl + the Go extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ~1.4 GB |
| **java**       | [`java/`](./java)             | base + JDK + Maven + Gradle + google-java-format + the Java extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ~1.6 GB |
| **rust**       | [`rust/`](./rust)             | base + rustup/cargo + clippy/rustfmt + cargo-audit + rust-analyzer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ~1.7 GB |

> Agents note: the AI-agent extensions (Claude Code + Codex) and the `claude` CLI
> bundle ~1 GB of native binaries, so they live in **omnibus only** — the slim
> per-language variants stay lean (typescript ~1.2 GB, etc.) and `base` is ~0.8 GB.
> A slim-variant user who wants the agents installs them at runtime via the user-CLI
> path (`npm i -g @anthropic-ai/claude-code` + the extension; see #90/#91).

> Dev tooling (#95): each language ships a curated lint/format/type-check/dead-code/
> SAST set so a workspace matches CI out of the box — **cross-cutting** prettier,
> eslint, knip, jscpd, and Trivy (base, every variant); **Python** ruff, ty, vulture,
> bandit, semgrep; **Go** golangci-lint, staticcheck, deadcode, dupl; **Rust** clippy,
> rustfmt, cargo-audit; **Java** google-java-format (the formatter). CLIs install to
> system paths (not the EBS-shadowed `$HOME`) so they survive the home mount and stay
> on PATH for every shell.

The variants are smoke-tested by `packages/e2e/src/image-variants.e2e.ts` (each
ships its toolchain + dev tooling + the shared base behaviour, carries no other
language, and — being slim — carries no AI agents); the omnibus (agents + every
toolchain) by `workspace-toolchain.e2e.ts`. Built and run by the path-gated
`golden-images` CI workflow (variants) / the `e2e` job (omnibus).

Build the base first, then a variant `FROM` it via the `BASE` build-arg:

```sh
docker build -t edd-base infra/images/base
docker build --build-arg BASE=edd-base -t edd-workspace infra/images/omnibus
```

The e2e/live suites launch the **omnibus** image (tagged `edd-workspace:e2e`).

## Runtime behaviour (shared, from `base`)

At startup the entrypoint starts `sshd` (whose `AuthorizedKeysCommand` calls the
control plane's `ssh-authorize` to admit a registered key), seeds default editor
settings (Dark mode, write-if-absent on the EBS home volume), then runs the
idle-agent and OpenVSCode Server as the non-root `workspace` user (via `gosu`).

The default extensions (the cross-cutting dev extensions in every image; the AI
agents in omnibus only; each variant's language extensions) are installed into
OpenVSCode's **built-in** extensions dir at image build
(`/opt/openvscode-server/extensions`), so they load read-only with no runtime copy
and survive the volume mount; the user's own extensions still install into the
volume's extensions dir and persist across restarts.

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
awsvpc private IP, and a same-VPC client connects with a **registered key** (the
dual-trust `ssh-authorize` flow — no CA). Image publication to the
Terraform-created ECR repositories and real deploy scanning remain AWS-gated
(use [`scripts/publish-images.sh`](../../scripts/publish-images.sh) or the
`release` workflow once the account decision lands).
