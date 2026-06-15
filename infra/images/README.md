<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# infra/images

Curated **golden workspace images**: OpenVSCode Server, OpenSSH `sshd` + our SSH
CA trust, the idle-agent, the git-credential broker, and a non-root `workspace`
user, plus language toolchains. They are published to ECR and surfaced in the admin
catalog (the base-image allow-list). Extensions are sourced from **Open VSX** (not
the MS marketplace).

## A collection built on a shared base

| Image       | Dir                                           | Contents                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **base**    | [`base/`](./base)                             | The common runtime: OpenVSCode Server, `sshd` + CA, idle-agent, entrypoint, git-credential helper, `workspace` user, **Node 22**, the user-CLI setup (npm global prefix in `$HOME` + PATH across the shell matrix), and the Dark-mode default. **No compilers / language toolchains.** Every variant builds `FROM` this. |
| **omnibus** | [`omnibus/`](./omnibus)                       | base **+ the full polyglot toolchain** — C/C++ (`build-essential`), Go, Java (JDK + Maven + Gradle), Rust, Python 3 (+ uv), Node package managers (yarn/pnpm/bun), Playwright (+ headless Chromium). The "everything" image.                                                                                             |
| _planned_   | `typescript/` `python/` `go/` `java/` `rust/` | Slim per-language variants `FROM base` (see `DO_NEXT.md`).                                                                                                                                                                                                                                                               |

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
