# STATUS.md — ecs-dev-desktop

> Where the project is right now. Update after every task; past tense at PR close.

**Last updated:** 2026-07-09. The current branch added `opencode` as a fifth
workspace interface without changing the locked single-domain proxy architecture.
The control-plane/editor contracts, DynamoDB entity enums, workspace-create UI,
admin catalog UI, deployed smoke editor list, screenshot smoke, dev bootstrap,
and e2e image/toolchain checks all included `opencode`. The golden base image
installed `opencode-ai@1.17.15`, and `EDD_EDITOR_MODE=opencode` launched the
real `opencode web` server on port 3000 with
`OPENCODE_SERVER_USERNAME=opencode` and `OPENCODE_SERVER_PASSWORD` set from the
workspace connection token. Missing opencode, missing `CONNECTION_TOKEN`, or
`EDD_DISABLE_CONNECTION_TOKEN=1` in opencode mode failed loudly.

PR #212 CI exposed stale e2e harness coordinates rather than a reason to restore
fallbacks. Golden-image launch paths, the shared live ECS harness, and the older
user-journey web-app harness now supplied explicit editor connection secrets;
the production real-provider path still failed immediately if
`COMPUTE_PROVIDER=ecs` lacked `EDD_AGENT_SECRET` or `EDD_CONNECTION_SECRET`.

The branch also removed the remaining random OpenVSCode connection-token
fallback: standalone/tokened editor startup now required `CONNECTION_TOKEN`
unless `EDD_DISABLE_CONNECTION_TOKEN=1` was explicitly set. The in-app workspace
proxy passed editor context from the custom server, preserved the existing
OpenVSCode, Claude, Codex, and Monaco token behavior, and added an opencode-only
adapter: strip `/w/<workspace-id>` for upstream requests, inject Basic auth from
the derived workspace token, and rewrite opencode HTML/JS/CSS root references
back under `/w/<workspace-id>/`. Local verification had shown opencode's web
server had no base-path flag and emitted root-absolute assets/API base logic, so
this was the minimal path-compatible integration rather than a second public
surface.

Focused verification passed with `pnpm exec vitest run src/domain/editor.test.ts`
in `packages/core`, `pnpm exec vitest run lib/workspace-proxy.test.ts` in
`apps/web` with loopback access, `pnpm exec vitest run src/dto.fuzz.test.ts` in
`packages/control-plane`, `shellcheck infra/images/base/smoke.sh
infra/images/base/entrypoint.sh`, `pnpm --filter @edd/web build`, and lint for
`@edd/web`, `@edd/core`, `@edd/control-plane`, and `@edd/db`.

After PR #212's first CI pass, the `e2e` job failed because golden workspace
tasks exited before readiness: the branch had correctly removed OpenVSCode's
random token fallback, but several golden-image e2e launch paths still omitted
the editor connection secret. The branch then wired explicit
`connectionSecret` values through the direct golden-image e2e providers and the
shared live ECS app harness, and the real web provider path failed immediately
when `COMPUTE_PROVIDER=ecs` lacked `EDD_AGENT_SECRET` or
`EDD_CONNECTION_SECRET`. Verification after that fix passed `pnpm build`,
`pnpm lint`, `pnpm test` with loopback access, `pnpm check-deps` with registry
access, `pnpm --filter @edd/compute-ecs test`, `pnpm --filter @edd/e2e lint`,
`pnpm exec vitest run lib/control-plane.test.ts` in `apps/web` with loopback
access, and `git diff --check`. A local `pnpm test:e2e:local` attempted the
same Docker-backed tier as CI and built the fixed golden base image, but the
machine had only 12 GiB free and Podman failed committing the omnibus image
layer with `no space left on device` before tests started.

**Last updated:** 2026-07-08. The current branch made the production smoke and
workspace UI stricter after PR #210's merge/deploy exposed that green ECS/app
health did not prove the expected workspace image or rendered editor behavior.
The `golden-images` workflow now ran for every `main` push instead of only
image-path changes, so workspace-image builds were no longer skipped when the
editor/runtime code changed. The deployed workspace smoke scripts required
`EXPECTED_SHA`, waited until the catalog exposed an enabled image with that tag,
and failed loudly if production still pointed at an older golden image. A focused
unit test covered expected-tag selection and stale-image rejection.

The workspace list and detail pages became more responsive to out-of-band state
changes: the list refreshed every two seconds while any workspace rows existed,
and the detail page polled status every second and logs every four seconds. This
addressed stale UI after reconciler/admin/other-tab stop or delete events.

Monaco gained the terminal controls reported missing in production. Terminal
tabs disappeared when their WebSocket disconnected, the visible terminal control
opened the panel and created a tab when needed, and the panel gained resize,
minimize, maximize, and close controls. The terminal server also failed the
terminal channel loudly when PTY spawn failed instead of taking down the whole
Monaco editor process. The admin base-image form exposed all four editor choices
instead of only OpenVSCode/Monaco, matching the workspace-create UI and persisted
contract.

Vendor-local Claude/Codex verification remained unresolved rather than guessed.
Local verification showed `codex app-server` exposed stdio/WebSocket/Unix-socket
protocol transports plus `/readyz` and `/healthz`, and OpenAI's own docs
described app-server as the protocol interface used by rich clients such as the
VS Code extension. `codex app` was a desktop-app launcher and `chatgpt.com/codex`
was the Codex web/cloud/app surface, not a local Linux HTTP UI command. Local
Claude Code `--help` exposed `--remote-control [name]`, but no local HTTP/web
server subcommand; starting Remote Control locally opened the Claude Code TUI and
did not expose a listening browser UI. The branch therefore did not invent an
EDD-authored chat UI or silently relabel Monaco/OpenVSCode as the requested local
web UI.

Focused verification passed with `pnpm --filter web exec vitest run
scripts/deployed-workspace-smoke-lib.test.ts`, focused web eslint for the touched
page/components/scripts, `pnpm --filter @edd/editor-monaco build`, `pnpm
--filter @edd/editor-monaco test` with loopback access, `pnpm --filter web
lint`, `pnpm --filter web test` with loopback access, `pnpm --filter
@edd/core test`, `pnpm --filter @edd/api-contracts test`, `pnpm actionlint`, and
`git diff --check`. The first sandboxed Monaco test attempt failed only because
the sandbox denied `listen 127.0.0.1` with `EPERM`; the same suite passed with
local loopback access. A local Chromium check against the rebuilt Monaco server
captured `/private/tmp/edd-monaco-after-terminal-ui.png` and verified the editor
accepted typing without the read-only overlay, the smoke file appeared in the
explorer, and terminal controls rendered without breaking the layout.

**Last updated:** 2026-07-08. After PR #209 merged as
`e6b87475c1df6393dddacb82ad998711ec39b052`, the release workflow
`28950005919` succeeded in 3m34s and production reported
`deploy.sha=e6b87475c1df` from `/api/healthz`; `/api/readyz` was ready and
`/workspaces` returned HTTP 200. ECS showed `edd-prod-control-plane` steady at
desired/running/pending `2/2/0` on task definition `:34` and
`edd-prod-ssh-gateway` steady at `1/1/0` on task definition `:34`, both using
ECR images tagged `e6b87475c1df`. The golden-images workflow `28950006155`
succeeded in 13m17s and pushed
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:e6b87475c1df`
with digest `sha256:f5c494343dd355d08bd4b32122382adabf5241f964075a62bc6503c1ab9bd8af`.

The deployed app was not considered verified. The `post-deploy-smoke` workflow
run `28950258091` failed after capturing only an OpenVSCode screenshot; it then
timed out/fell over in the Monaco path and uploaded no artifact because
`EDD_SHOT_OUT` was relative to `apps/web` while artifact upload read
repo-root `temp/workspace-screenshots`. A local rerun against production exposed
two real methodology/product failures: the smoke had pre-primed editor tokens
through helper fetches instead of testing a user's first browser navigation to
`/w/<id>/`, and Monaco still rendered `Cannot edit in read-only editor` after a
file opened.

The current branch fixed the root issue behind OpenVSCode `Forbidden` reports:
the proxy no longer treats the mere presence of `vscode-tkn`/`edd-editor-token`
as proof that the current workspace token is established. It now suppresses
token injection only when the query or cookie value equals the derived token for
that exact workspace/editor mode, so stale browser cookies from another
workspace cannot make EDD forward a wrong token to OpenVSCode. The deployed
screenshot smoke now opens `/w/<id>/` directly in Chromium with only the EDD
session cookie, preserving the real browser redirect/cookie handoff, and writes
per-editor failure screenshots/text/HTML before failing loudly. The workflow now
uses an absolute screenshot directory and age-eligible
`actions/upload-artifact@v7.0.1`. Monaco no longer initializes the editor widget
as read-only; saving still no-ops until a real file is selected.

Verification on this branch passed with `pnpm lint`, `pnpm test` with loopback
access, `pnpm build`, `pnpm actionlint`, `pnpm check-deps` with registry network
access, `pnpm dead-code`, `pnpm --filter @edd/editor-monaco build`,
`pnpm --filter @edd/editor-monaco test` with loopback access,
`pnpm --filter web lint`, `pnpm --filter web build`, `pnpm --filter web exec tsc
--noEmit`, and focused escalated web proxy/smoke-related tests. A sandboxed
`check-deps` attempt failed only at Terraform registry DNS, and sandboxed
loopback tests failed with `EPERM`; the same commands passed with the required
network/loopback access. PR #210 CI then exposed a separate workflow problem:
the `e2e` job reached the browser section but timed out during
`playwright install --with-deps chromium` while apt slowly fetched optional font
packages from the Ubuntu mirror. The branch removed repeated `--with-deps`
installs from the shared Playwright action, `post-deploy-smoke`, and `pages`;
browser jobs now install Chromium itself and fail loudly only if a required
runtime library is actually absent. `pnpm actionlint` passed after that change,
and PR #210's reruns `28955736899` and `28955736971` passed every required CI
job, including `build-test`, `playwright`, `integration`, `e2e-https`, `e2e`,
and `terraform-sim`.

**Last updated:** 2026-07-08. PR #208 merged as
`b48030c13956dcb803316bfbcc9e2dc33518d001`. The release workflow
`28942464820` succeeded: image publication started at `2026-07-08T12:27:10Z`,
ECS service deployment ran from `12:30:08Z` to `12:30:19Z`, and the public app
reported `deploy.sha=b48030c13956` with `/api/healthz`, `/api/readyz`, and
`/workspaces` all healthy. ECS cluster `edd-prod-workspaces` showed
`edd-prod-control-plane` steady at desired/running/pending `2/2/0` on task
definition `:33` and `edd-prod-ssh-gateway` steady at `1/1/0` on task
definition `:33`.

The post-merge `post-deploy-smoke` workflow run `28942687870` failed before it
could open workspaces because the GitHub runner had no Playwright Chromium
browser installed:
`browserType.launch: Executable doesn't exist at ... chromium_headless_shell`.
The current follow-up branch installed Chromium explicitly in the smoke
workflow instead of relying on an implicit runner cache.

The golden-images workflow run `28942465055` succeeded and pushed
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:b48030c13956`
with digest `sha256:070bd7266d013c61f558bf351e696dab92ed36f09a0f27fbdb0fe4427e71942b`;
the production catalog row `img-seed-omnibus` pointed at that tag at version
`8`. A live screenshot smoke was rerun against production after the catalog
updated. It created OpenVSCode, Monaco, Claude Local Web UI, and Codex Local Web
UI workspaces on `omnibus:b48030c13956`, captured screenshots under
`/private/tmp/edd-workspace-screenshots-b480/`, and visual inspection confirmed
VS Code Web, Monaco with terminal, Claude Local Web UI `status: running`, and
Codex Local Web UI `status: running`. The Codex screenshot no longer showed the
previous missing sandbox-helper warning.

That live smoke also exposed a cleanup blind spot. The previous smoke scripts
sent DELETE requests and exited without proving the smoke-created workspaces
actually reached the `terminated` tombstone. Production did eventually converge
all smoke workspaces to `terminated`, but the deployed app accepted
`active:false` functional heartbeats while records were already `deleting`,
which caused `finishDeleting` version races and slow cleanup. The current branch
made non-running/non-idle heartbeats fail with a conflict, added integration
coverage for stopped/deleting `active:false` heartbeat reports, and changed both
deployed-workspace smoke scripts to wait for every created workspace to reach
`terminated` after DELETE.

Focused verification for the current branch passed with
`pnpm --filter @edd/control-plane test`, `pnpm --filter @edd/control-plane
test:integ` after starting `docker-compose.tier2.yml`, `pnpm --filter
@edd/control-plane lint`, `pnpm --filter web lint`, focused eslint for the
deployed smoke scripts, `pnpm actionlint`, and a production one-shot
`waitTerminated` check against an already terminated smoke workspace. A
sandboxed integration attempt failed with `EPERM` on `127.0.0.1:4566`; with
loopback access but before the local substrate was started, the same suite
failed with `ECONNREFUSED`. After the repo's tier-2 substrate was started, the
suite passed.

**Last updated:** 2026-07-08. The current follow-up branch corrected the
Claude/Codex workspace UI contract and the Monaco editability gap found against
production `omnibus:b48030c13956`. Live production still served the removed
EDD-authored Claude/Codex wrapper pages on `/w/<id>/`, and Monaco showed
`Cannot edit in read-only editor` before any file was opened and did not refresh
the explorer after `touch hello.txt` in the terminal. Local image inspection
verified the installed vendor browser UIs were the OpenVSCode extensions
`anthropic.claude-code` and `openai.chatgpt`; the Codex CLI `app-server` exposed
a WebSocket protocol, not an HTML page.

The branch removed `vendor-harness-server.js` from the base image and changed
`EDD_EDITOR_MODE=claude`/`codex` to fail loudly unless the corresponding CLI and
vendor OpenVSCode extension were installed, then launch OpenVSCode with the
vendor extension UI selected. Claude/Codex therefore used the same `vscode-tkn`
connection-token cookie as OpenVSCode, and the proxy/smoke helpers were updated
accordingly. The EDD OpenVSCode extension opened `claude-vscode.editor.open` or
`chatgpt.openSidebar` on startup for those modes.

The Monaco editor added a real New File control and refreshed its explorer from
the workspace filesystem every two seconds, so files created from the integrated
terminal became visible without a reload. The post-deploy screenshot smoke was
tightened to reject the old wrapper text, unauthorized/forbidden/502/server
errors, and Monaco read-only edit failures; for Monaco it now creates a file via
the page, waits for it to appear in the explorer, opens it, and types into the
editor.

Verification passed with `pnpm lint`, `pnpm test` with loopback access, `pnpm
build`, `pnpm dead-code`, `pnpm actionlint`, `pnpm check-deps` with registry
network access, `shellcheck infra/images/base/entrypoint.sh
infra/images/base/smoke.sh`, `node --check` for the EDD OpenVSCode extension,
focused web proxy/token tests, the Monaco build/lint/test suite, and the
base-image Docker smoke. Local Chromium screenshots from the rebuilt
`edd-base:smoke` image showed Codex serving the OpenAI Codex sidebar UI and
Claude serving the Anthropic Claude Code webview inside OpenVSCode, not the old
EDD wrapper.

**Last updated:** 2026-07-08. PR #207 merged as
`24fc78f7bb052ff099a730dccaa9f7c025c77e91` and the control plane rolled to
that SHA. `https://app.edd.e6qu.dev/api/healthz` reported
`deploy.sha=24fc78f7bb05`, `/api/readyz` was ready with DynamoDB ACTIVE, and
`/workspaces` rendered HTTP 200 with the unauthenticated "Not signed in" page.
ECS completed the no-downtime rollout on task definition `:32`. The verified
cluster coordinate was `edd-prod-workspaces`; `edd-prod-control-plane` was
ACTIVE with desired/running/pending `2/2/0`, `edd-prod-ssh-gateway` was ACTIVE
with `1/1/0`, and both services reported rollout `COMPLETED` with
minimum/maximum healthy deployment settings `100/200`.

The first post-deploy smoke run failed before workspace verification because the
real release bootstrap state lagged the merged source: repo variables
`EDD_DYNAMODB_TABLE` and `EDD_AUTH_SECRET_ID` were absent, then the release role
lacked `secretsmanager:GetSecretValue`, and then DynamoDB's customer-managed
KMS key denied `kms:Decrypt`. The real bootstrap was rerun with explicit
production coordinates, and this branch made the source bootstrap require
`EDD_RELEASE_DYNAMODB_KMS_KEY_ARN` and grant only
`kms:Decrypt`/`kms:GenerateDataKey` through `kms:ViaService =
dynamodb.eu-west-1.amazonaws.com`. No fallback or implicit discovery was added.

The workspace-open smoke itself also needed a real-session email. The app
correctly rejected the synthetic smoke session with
`your account has no email address; a workspace requires one to be reachable`.
The smoke session now signs a deterministic `@smoke.edd.local` email into the
current Auth.js JWT so workspace creation exercises the same real-session
requirement instead of bypassing it.

Live verification was completed against production after those fixes. The fixed
smoke created and opened OpenVSCode, Monaco, Claude Local Web UI, and Codex
Local Web UI workspaces through `https://app.edd.e6qu.dev/w/<id>/`, all on
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:24fc78f7bb05`.
A new Playwright screenshot verifier then created a fresh workspace for each
editor mode, opened each one in Chromium through the public app, rejected
unauthorized/forbidden/server-error pages, and saved screenshots. Visual
inspection confirmed OpenVSCode loaded VS Code Web, Monaco loaded the Monaco UI
and terminal, Claude showed the Claude Local Web UI harness with `status:
running`, and Codex showed the Codex Local Web UI harness with `status:
running`. After the smoke-helper refactor, the exact screenshot verifier was run
again against production and inspected screenshots under
`/private/tmp/edd-workspace-screenshots-rerun/`.

The screenshot pass exposed a real Codex runtime warning: Codex reported missing
sandbox prerequisites in the Linux workspace image. The official Codex sandbox
docs say Linux/WSL should install `bubblewrap`, so the base image now installs
`bubblewrap` and the base-image smoke asserts `bwrap` exists. This addressed the
underlying missing dependency instead of suppressing the warning.

Verification on this branch passed with `pnpm --filter web exec eslint
scripts/check-deployed-workspace-open.ts scripts/screenshot-deployed-workspaces.ts`,
`pnpm --filter web lint`, `pnpm --filter web build`, `pnpm --filter web test`
with loopback access, `pnpm dead-code`, `pnpm actionlint`, and `shellcheck
scripts/bootstrap-release-oidc.sh infra/images/base/smoke.sh`. The base-image
Docker smoke passed after building the image, asserting `bwrap` exists, and
probing Monaco, Claude, and Codex modes. A sandboxed web test run failed only
because the sandbox denied a `127.0.0.1` listener with `EPERM`; the same suite
passed with local loopback access. The local screenshot artifacts were saved
under `/private/tmp/edd-workspace-screenshots/`, and the screenshot-created
workspaces converged to `terminated` with `desiredState=deleted`. GitHub
Actions showed PR #207's `release` and `golden-images` workflows succeeded, and
the old `post-deploy-smoke` run failed on the bootstrap/IAM/KMS/email gaps that
this branch corrected.

**Last updated:** 2026-07-08. The earlier follow-up branch addressed the
remaining production editor-open failures with no fallbacks. The editor proxy
keyed the connection-token redirect suppression by the selected workspace editor
mode. The latest branch kept that model but changed Claude/Codex to OpenVSCode
surfaces, so OpenVSCode, Claude, and Codex use `vscode-tkn`, while Monaco uses
`edd-editor-token`. A stale cookie from one
editor family no longer suppresses token injection for another family, which
matched the live `Forbidden`/`unauthorized` reports for OpenVSCode, Monaco,
Claude Local Web UI, and Codex Local Web UI. Exact `/w/<id>` and `/w/<id>/`
direct opens for a non-ready/stopped workspace redirect to the status page with
`autoopen=1`, while non-root API/subresource paths still fail honestly through
the proxy.

The branch also added server-side Auth.js session state. Login now creates a
versioned `AUTH_SESSION` row in DynamoDB and embeds `authSessionId` plus
`authSessionVersion=1` in the signed JWT cookie. Every session/proxy validation
requires that current server-side row to be active, unexpired, and unrevoked;
old-format cookies with no current session version lose their principal and
force re-login. Logout revokes the server-side row and explicitly clears the
Auth.js cookie names/chunks. The smoke-test helper creates and revokes its own
server-side admin session through the same path.

The workspace image entrypoint stayed fail-loud. `EDD_EDITOR_MODE=monaco`
started only Monaco, and the latest branch changed `claude`/`codex` to require
their vendor OpenVSCode extensions and then start OpenVSCode with that vendor UI
selected. An unknown editor mode exits with an error instead of falling back to
OpenVSCode or Monaco.

Post-deploy verification was extended beyond app readiness. The
`post-deploy-smoke` workflow now assumes the release AWS role via GitHub OIDC,
reads the deployed `AUTH_SECRET` from Secrets Manager, creates a current-format
server-side smoke auth session in DynamoDB, creates one workspace for each of
OpenVSCode, Monaco, Claude Local Web UI, and Codex Local Web UI, waits for each
to become `running`/`functional=ok`, and opens `/w/<id>/` through the public app
while preserving browser-like cookie path scoping. The bootstrap script now
writes the required non-secret smoke coordinates and grants the release role
only the needed `secretsmanager:GetSecretValue` and DynamoDB item permissions
for that check.

Local verification passed on this branch: `pnpm build`, full `pnpm test`,
`pnpm test:integ`, `pnpm test:e2e`, `pnpm lint`, `pnpm check-deps`,
`pnpm dead-code`, `pnpm actionlint`, `shellcheck scripts/bootstrap-release-oidc.sh
infra/images/base/entrypoint.sh`, focused workspace-proxy/editor-handshake
tests, and the Auth.js callback e2e. After CI exposed an HTTPS-only table-setup
coordinate bug, the Auth.js callback e2e was corrected to use `aws.endpoint`
instead of the HTTP-only DynamoDB endpoint, and the exact failing HTTPS command
passed locally against `docker-compose.https.yml`. Sandboxed loopback/
local-endpoint attempts failed with `EPERM` and the same commands passed when
rerun with local network access.

**Last updated:** 2026-07-08. PR #206 merged as
`3561532b4ee52263ef118ffc63836d82d5667ed0` and production rolled the control
plane to that SHA. `https://app.edd.e6qu.dev/api/healthz` returned
`deploy.sha=3561532b4ee5`, `/api/readyz` was ready with DynamoDB ACTIVE, and
`/workspaces` returned HTTP 200 with the unauthenticated "Not signed in" page
instead of the previous Next.js digest. ECS reported `edd-prod-control-plane`
steady at desired/running `2/2` on task definition `:31` and
`edd-prod-ssh-gateway` steady at `1/1` on task definition `:31`. Release run
`28929660012` and post-deploy smoke run `28929886726` both succeeded.

The post-merge golden image workflow also succeeded. Workflow run
`28929660072` built and pushed
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:3561532b4ee5`
(`sha256:7d7e5ef2...`, pushed `2026-07-08T11:57:01+03`), and the production
base-image catalog row `img-seed-omnibus` pointed at that tag at catalog version
`5`.

Production was not fully clean. DynamoDB still held four workspace records:
OpenVSCode `ws-5da4647e-b3d9-401b-8847-27344c02bb8b` and Monaco
`ws-8631d0e9-2baa-4646-8491-27453029c303` were stopped on the old
`omnibus:f82e61db669c` image, while Claude
`ws-30b1245c-8ebd-4817-aa6d-1c2e0d395896` and Codex
`ws-6eba0d37-ec44-4d35-b47e-74c8ee5b7298` were still `error` on that same old
image. CloudWatch still showed `edd-prod-workspaces-stuck-error` in ALARM with
two errored workspaces, and `edd-prod-reconciler-dlq` remained ALARM with old
DLQ debris. From this session, unauthenticated public health and page rendering,
ECS service health, ECR publication, and catalog rollout were verified; creating
and opening fresh authenticated workspaces for all four interface modes still
needed browser/session verification.

After the user created fresh workspaces on the new catalog image, production
held four `desiredState=present` workspaces, all `running`, all on
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:3561532b4ee5`,
and all reporting `functional=ok`: Claude
`ws-3ffe1107-07d4-4a41-94d5-909cca2e9d98`, Monaco
`ws-755b4645-e1ea-49f2-96ae-9a4f14287543`, Codex
`ws-afb14de5-9691-4cdc-a23a-2d079708b420`, and OpenVSCode
`ws-fed0e000-b9e1-4b18-b3c4-545bbec46f23`. ECS showed all four workspace
containers RUNNING on the new image. Workspace logs showed OpenVSCode serving
on `:3000`, Monaco serving on `:3000`, the Claude Local Web UI harness listening
on `:3000/w/ws-3ffe1107-.../`, and the Codex Local Web UI harness listening on
`:3000/w/ws-afb14de5-.../`. The previous old-image OpenVSCode, Monaco, Claude,
and Codex records were all `terminated` with `desiredState=deleted`, and
`edd-prod-workspaces-stuck-error` returned to OK. `edd-prod-reconciler-dlq`
remained ALARM from old DLQ debris.

**Last updated:** 2026-07-08. The follow-up branch
`fix/prod-workspace-open` addressed the production workspace-open failures found
after PR #205 deployed. The public app itself was healthy at merge commit
`885c560ab006`: `/api/healthz` reported that SHA, `/api/readyz` was ready with
DynamoDB ACTIVE, ECS ran the control plane at desired/running `2/2`, and the
manual rerun of `post-deploy-smoke` (`28926483388`) passed after the required
non-secret repo variable `EDD_APP_URL=https://app.edd.e6qu.dev` was configured.

The workspace-specific production failures were real and separate from the
control-plane smoke. OpenVSCode and Monaco workspaces were running, but direct
opens of `/w/<id>/` could reach the editor without a connection-token handoff
when browser navigation headers were sparse, yielding OpenVSCode `Forbidden` or
Monaco `unauthorized`. The proxy now treats the exact workspace root path as a
document navigation even without `Sec-Fetch-Dest`/HTML `Accept`, while still
leaving non-root API/subresource requests unmodified.

Claude and Codex workspaces failed in production because the base image still
exited loudly for `EDD_EDITOR_MODE=claude|codex` after the no-fallback change.
This branch kept all four product choices (OpenVSCode, Monaco, Claude Local Web
UI, Codex Local Web UI) and wired the vendor harness modes without serving
Monaco under those names. Claude starts the vendor `claude --remote-control
<workspace-id>` session under a pseudo-terminal, because the CLI exits in
non-interactive mode without a TTY. Codex starts the vendor `codex app-server`
process on loopback and the harness health endpoint probes the vendor
`/healthz`; the attempted `codex remote-control start` path was rejected after
Docker evidence showed it requires a standalone installer layout not present in
the image.

The snapshot policy was also pinned for errored workspaces. Scheduled snapshots
only consider running/idle workspaces with live volumes, explicit snapshots of
errored workspaces return a conflict before storage I/O, and integration
coverage now asserts both the control-plane guard and reconciler candidate
exclusion. Terminated/deleted workspaces already remained excluded.

Local verification passed on this branch: `node --check` for the vendor harness,
`shellcheck` for the touched shell scripts, focused web proxy/API tests,
`pnpm --filter web lint`, `pnpm --filter web build`, full `pnpm --filter web
test` with loopback access, focused control-plane and reconciler integration
tests with local DynamoDB access, `pnpm lint`, `pnpm build`, full `pnpm test`
with loopback access, and `infra/images/base/smoke.sh`, which built the base
image and confirmed Monaco, Claude, and Codex harness modes served healthy
endpoints.

**Last updated:** 2026-07-08. After PR #204 merged, production release run
`28910392738` for merge commit
`f82e61db669c8b22a962ad169ff9933761152796` succeeded in 6m47s and rolled the
control plane. ECS cluster `edd-prod-workspaces` ran `edd-prod-control-plane` at
desired/running `2/2` and `edd-prod-ssh-gateway` at `1/1`; both deployments were
COMPLETED. The separate `golden-images` workflow run `28910392717` succeeded and
ECR contained `edd-prod/golden/omnibus:f82e61db669c`
(`sha256:ef8c5ebc...`, pushed `2026-07-08T04:31:44+03`).

The skeptical app check found a real production page failure that ECS steady
state did not catch. `https://app.edd.e6qu.dev/workspaces` rendered the Next.js
error boundary with digest `3655293926`. CloudWatch showed
`TypeError: Cannot destructure property 'cpuUnits' of 'a' as it is undefined`,
coming from `workspace-resources.ts` while `WorkspaceService.list` mapped
persisted workspace rows. DynamoDB contained nine workspace records without the
now-required `resources` map. Those nine invalid workspace rows were deleted
operationally because there was no legacy data to preserve; a follow-up scan
returned zero workspace rows, `/workspaces` rendered the unauthenticated "Not
signed in" page with HTTP 200, `/api/readyz` was ready, and the next reconciler
sweep completed with `fleet.workspaces.total = 0` and no per-workspace errors.

This branch kept the no-fallback behavior but improved the blast radius and test
coverage. Missing persisted `resources` now fails loudly as
`invalid persisted workspace <id>: missing resources` instead of an opaque
destructuring crash, invalid resource values are wrapped with the workspace id,
and an integration regression removes `resources` from a raw DynamoDB row and
asserts the explicit error. `/api/healthz` now includes baked deploy metadata
(`deploy.sha` and `deploy.time`) from `@edd/config`, and the new
`scripts/check-deployed-app.sh` smoke check verifies `/api/healthz`,
`/api/readyz`, and `/workspaces` rendering. The release workflow no longer waits
for ECS service stability inside the release job; it submits the task-definition
and service updates, then the separate `post-deploy-smoke` workflow skeptically
waits for the public app to report the expected SHA and render the user-facing
page. Bootstrap now writes required non-secret `EDD_APP_URL` alongside the
release coordinates so the smoke workflow has an explicit target and fails
loudly if it is absent.

Production still had operational debt after the code/data fix. CloudWatch alarm
`edd-prod-workspaces-stuck-error` moved back to OK after deleting the malformed
workspace rows. `edd-prod-reconciler-dlq` still had five old messages from an
inactive `edd-prod-reconciler:6` target, and `edd-prod-reconciler-failed` still
reflected the recent invalid-workspace failures until the alarm window aged out.
Reconciler post-sweep cost reporting still warned on old `session.create` audit
events that predated resource recording; those rows were not deleted because
that audit cleanup needed an explicit operational decision. Live ALB/NLB target
group health-check intervals also still showed 30 seconds in AWS while Terraform
source expected 10 seconds, because the release workflow rolls images only and
does not apply Terraform.

Local verification passed on this branch: `pnpm lint`, `pnpm build`, full
`pnpm test` (37/37 Turbo tasks), `pnpm test:integ` (27/27 tasks), `pnpm test:e2e`
(20/20 tasks; 46 e2e tests passed and 5 variant-image tests skipped because
variant images are built by the golden-images workflow), focused web health
tests, focused control-plane integration regression, `actionlint`, and
`shellcheck` for the touched shell scripts. Sandboxed loopback/local-endpoint
runs failed with `EPERM` and passed when rerun with local network/Docker access.

Earlier 2026-07-07 release-inspection notes remain below for history.

The live app itself was healthy but stale. `https://app.edd.e6qu.dev/api/healthz`
returned 200, `/api/readyz` returned 200 with DynamoDB ACTIVE, the ALB control-plane
target group had two healthy targets, and the SSH target group had one healthy
target. ECS still ran task definitions `edd-prod-control-plane:26` and
`edd-prod-ssh-gateway:26`, both on image tag `2d231f5`; the latest task-definition
families had no revision beyond `:26`. DynamoDB showed the `github-main`
image-source state had observed and handled the PR #201 SHA, but the trigger row
`0ca8ebcf-d392-4331-a1d3-49f4d6324d41` still showed `status=queued` even though
CodeBuild had succeeded, confirming that the missing production rollout kept the
new image-source reconcile sweep out of service.

The follow-up branch `fix/release-rolls-ecs` fixed the release gap without adding
fallbacks. The `release` workflow still built only web/control-plane and
SSH-gateway images under CI (`EDD_BUILD_TARGET=web`; workspace/golden images
remained EDD-owned), then called the new `scripts/deploy-release-images.sh`. That
script read the current AWS task definitions, changed only the image references,
registered fresh control-plane/reconciler/SSH task-definition revisions, updated
the control-plane and SSH ECS services, retargeted the reconciler Scheduler
schedule, and waited for ECS service stability. The bootstrap script's release role
policy was expanded to the exact ECR/ECS/Scheduler/`iam:PassRole` actions required
for that path; GitHub still stored only non-secret release coordinates.

The same inspection found two operational issues still present in production:
the expected remote Terraform state object
`s3://edd-tfstate-edd-prod/ecs-dev-desktop/edd-prod/terraform.tfstate` was absent,
and CloudWatch alarms `edd-prod-reconciler-dlq` plus
`edd-prod-workspaces-stuck-error` were ALARM. The DLQ contained old Scheduler
failures from `2026-07-06T08:03:55Z` that targeted inactive task definition
`edd-prod-reconciler:7`; the live schedule now pointed at
`edd-prod-reconciler:26`. The workspace alarm matched one live workspace in
`state=error`, `desiredState=present`
(`ws-34afea9b-ca52-4484-ad73-8dd299dbefd5`).

PR #198 merged to `main` as `7fee654aaa67ae200251cfe67816f3701f04cb0c`. The
follow-up PR #199 branch `fix/docker-build-warnings` cleaned up the remaining
CI/deploy warning sources:
Debian slim workspace/SSH images now keep the man1 pages that installed packages
register as `update-alternatives` slave links, apt package installs run
noninteractively, the shell sweep runs zsh in POSIX-sh emulation, and the complete
Terraform example declares the S3 backend that the install/uninstall scripts
configure. Local verification passed: disposable Debian/Node package-install
reproductions emitted no `update-alternatives` warnings, the SSH proxy Dockerfile
built with `docker build --load`, `pnpm actionlint`, Terraform fmt/init/validate,
`pnpm check-deps`, `pnpm dead-code`, `pnpm cpd`, the full shell sweep,
`pnpm lint`, `pnpm build`, and `pnpm test`.

PR #197 merged and was deployed to production as control-plane tag `2d231f5`.
`scripts/install.sh --verify` was green after deploy
(ALB health 200, control-plane 2/2, reconciler enabled, `/api/readyz` 200, no
Terraform drift). The GitHub push webhook was configured on `e6qu/ecs-dev-desktop`,
and a tracked golden CodeBuild run built
`edd-prod/golden/omnibus:2d231f50fad8` (3.06 GB compressed). The first rollout
exposed two real bugs: build-result reconciliation only ran when an admin opened
`/admin/images`, and the Terraform-seeded catalog item had no required CAS
`version`, so catalog rollout failed loudly instead of silently accepting malformed
state. The production seed row was corrected to `version=0`, then the catalog was
rolled through `CatalogService.rollImageTag` to
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:2d231f50fad8`
and persisted at version `1`.

The current follow-up branch fixed that production finding in code: the long-lived
control-plane server now runs an image-source reconcile sweep on a fixed interval
and at startup, missing image-source coordinates fail startup loudly, Terraform
seeds base-image catalog rows with `version = 0`, and `CatalogService` rejects any
persisted catalog row missing a numeric version instead of applying a compatibility
fallback. The branch also fixed a Tier-2 simulator race found while verifying the
follow-up: sockerless DynamoDB `GetItem` could panic with `fatal error: concurrent
map iteration and map write` while capacity accounting iterated a stored item map
that another request was mutating. The fix was reported upstream as
`e6qu/sockerless#777`, merged via `e6qu/sockerless#778`, and the pinned submodule
now points at upstream main commit `b5126463`, which made read paths snapshot
DynamoDB items under the existing item mutex before projection/capacity work.

The same branch also removed no-fallback violations found during verification:
the production e2e web harness supplied explicit image-source coordinates instead
of starting the server with missing required config; dev-auth required an explicit
password on every seeded account and removed the shared `EDD_DEV_PASSWORD` path;
unknown editor values threw instead of becoming OpenVSCode; and workspace images
exited loudly for `EDD_EDITOR_MODE=claude|codex` until the Anthropic/OpenAI local
web UI harness launchers were wired, rather than serving the Monaco terminal
wrapper behind those product names. The editor-monaco local server tests also
bound `127.0.0.1` explicitly and cleaned their terminal temp root, removing an
environment-sensitive wildcard-listener wrinkle found during the full test sweep.

Local verification for this follow-up passed: `pnpm --dir apps/web exec vitest run
lib/image-source-reconcile-sweep.test.ts lib/image-source.test.ts --pool=forks`,
`pnpm --dir packages/control-plane exec vitest run --config vitest.integ.config.ts
src/control-plane.integ.ts --pool=forks`, `pnpm --filter @edd/web lint`,
`pnpm --filter @edd/web build`, `pnpm --filter @edd/control-plane lint`,
`pnpm --filter @edd/control-plane build`, `pnpm --filter @edd/config build`,
`pnpm --dir packages/config exec vitest run src/dev-users.test.ts`,
`pnpm --dir packages/core exec vitest run src/domain/editor.test.ts`,
`pnpm --dir apps/web exec vitest run lib/dev-users.test.ts
lib/dev-users.fuzz.test.ts lib/workspace-proxy.test.ts
lib/image-source-reconcile-sweep.test.ts lib/image-source.test.ts --pool=forks`,
`pnpm --dir services/editor-monaco test`, `pnpm lint`, `pnpm build`,
`pnpm test`, `pnpm test:integ:local`,
`pnpm test:e2e:local` (46 passed, 5 skipped variant-image tests),
`pnpm check-deps`, `pnpm dead-code`, `pnpm cpd`,
`terraform fmt -check -recursive infra/terraform`,
and `env GOWORK=off go test -tags noui . -run
TestDDBItemSnapshotIsIndependentUnderConcurrentMutation -count=10` in the
sockerless AWS simulator module, including after moving the submodule pin to the
merged upstream `b5126463` commit. Full `pnpm test:integ:local` also passed again
against that merged upstream pin (27/27 tasks).

The branch also clarified `AGENTS.md` PR hygiene: there is only one active branch
and one active PR at a time; work continues on the active branch/PR, duplicate PRs
are not opened, and stacked/parallel PRs are not opened while another branch/PR is
active. It also recorded the project norm against anemic PRs: related fixes,
tests, docs, and boyscout cleanup stay in the active chunky PR until the human in
command says the work is done.

After PR #198 opened, CI `playwright` failed because its production custom-server
harness did not pass the now-required image-source coordinates, so `server.ts`
failed loudly at startup with `EDD_IMAGE_SOURCE_REPO is required`. The fix added
explicit Playwright-only image-source coordinates to `apps/web/playwright.config.ts`
and kept the production fail-loud config path intact. The same local repro showed
a repeated Node warning when both `NO_COLOR` and `FORCE_COLOR` were inherited; the
Playwright launch scripts now unset `NO_COLOR` before starting Playwright, and the
webServer command does the same before spawning `next build`/`server.ts`. The same
CI-warning sweep bumped `actions/cache` to `v6.1.0` and `pnpm/action-setup` to
`v6.0.9` after verifying those releases were age-eligible, removing the Node 20
action warning path and picking up the pnpm action maintenance release. Local
verification passed: `pnpm --filter web test:pw` passed 18/18 with no warning
output, `pnpm test` passed after allowing loopback listeners, and the
`editor-token-handshake` harness now failed fast on local-server bind errors and
cleaned its temp root instead of timing out and dereferencing an uninitialized
server during teardown. CI `e2e` then exposed the same required-coordinate gap in
the live Playwright harness; `live-cloud-setup.ts` now writes explicit image-source
coordinates into `temp/live-pw.env`, and local `pnpm --filter web test:pw:live`
passed the browser create-stop-wake-delete lifecycle against the container-mode
sim. The pnpm setup warning in CI was removed at the source by replacing
`pnpm/action-setup` with `corepack enable` after `actions/setup-node`, using the
repo's pinned `packageManager` version instead of the action's npm self-installer.
The dependency gate also found age-eligible drift in `typescript-eslint`
(`8.62.1` to `8.63.0`), so the root devDependency and lockfile were refreshed and
`pnpm check-deps` passed.

The same PR then fixed the circle-`i` layout problem: topbar help and workspace
details now open in fixed page overlays instead of inserting narrow panels into
page/card flow, and focused Playwright coverage asserted that opening help did
not change document layout while both overlay parents were fixed-position. The
snapshot policy was also pinned for deleted workspaces: explicit snapshot calls
against `terminated` tombstones returned conflict without creating a new snapshot,
and the reconciler scheduled zero snapshot candidates for terminated workspaces.

Shipped in this follow-up branch:

- **Workspace image source sync completed the rollout loop.** The EDD-owned GitHub
  push webhook still failed loudly with required repo/branch/app/golden/webhook-secret
  config and no polling fallback, and successful `golden` CodeBuild observations now
  rolled every configured golden catalog image tag (`<app>/golden/<variant>:<sha12>`)
  through the `CatalogService` CAS path. A failed catalog rollout marked the trigger
  failed with a visible reason instead of silently reporting success.
- **Snapshot policy matched the product requirement.** The default scheduled snapshot
  interval became 5 minutes, bounded per-workspace intervals were persisted and
  editable from the user card and admin detail view, and the reconciler honored the
  per-workspace interval before global defaults. GC kept only the referenced shutdown
  snapshot after the one-hour grace; therefore, when shutdown snapshotting succeeded,
  two hours later the older 5-minute scheduled snapshots for that workspace were
  reaped and only the shutdown snapshot remained.
- **Snapshot/resource UX shipped.** Workspace cards and admin workspace lists now
  surfaced last snapshot time; workspace/admin details showed snapshot cadence; the
  existing per-workspace monitoring path was linked from admin detail and disk usage
  appeared in the admin list.
- **GitHub repo launch gaps closed.** The new-session flow accepted a public
  `https://github.com/<owner>/<repo>` URL plus optional ref, and Entra-primary users
  could link a GitHub OAuth grant to their current account via signed short-lived
  `/api/github/connect/*` routes that stored the token in the existing encrypted
  credential service. The primary GitHub OAuth scope was aligned with repo/create
  operations.
- **Open issue sweep completed.** Valid issues #96, #98, #99, and #100 were addressed
  by this branch. Obsolete EDD issues #93 and #95 were closed after verifying the
  image Dockerfiles already installed the requested agent/polyglot tooling. Issue
  #92 was moved upstream to `e6qu/sockerless#776` and the EDD duplicate was closed.

Previously shipped and live in the merged post-launch wave:

- **Instant create** — `reserveWorkspace` returns the pre-generated URL in <1s, launch
  runs detached (fixed the 504 where blocking create outran the ALB 60s timeout).
- **Fast decoupled deploys** — `EDD_BUILD_TARGET=web` builds the control-plane image
  only (~3min / ~7min total vs ~22min); `golden` rebuilds workspace images separately.
- **Images admin console** (`/admin/images`) — per-image size + per-layer breakdown,
  trigger builds, last-20 build history, live CodeBuild logs (ImageOps port + AWS
  adapter + fake). The GitHub Actions post-merge workflow was superseded by an
  EDD-owned source-sync flow for deployed workspace images only: the control plane
  receives verified GitHub `push` webhooks, persists source/trigger records in
  DynamoDB, starts async `EDD_BUILD_TARGET=golden` CodeBuild runs for exact SHAs
  when workspace-image inputs changed, and exposes source/trigger/build status in
  `/admin/images`. There is no polling fallback; missing repo/webhook-secret config
  fails loudly. CI still owns control-plane release image builds so EDD remains
  releasable without an existing EDD deployment. PR #196 narrowed that public
  receiver with header/body guards in the route plus an ALB-associated WAF scoped
  to the webhook path.
- **Cancelable `stopping` state** — manual stop → `stopping` (snapshot + scale-to-zero
  after a grace) with a cancel/resume; converged by an in-process server sweep +
  reconciler backstop. Fixed several real bugs found by reproducing locally (DynamoDB
  Local): the DB serializer dropped `stopRequestedAt/By` (broke attribution + grace);
  `finishStop` could hang on a gone volume (now converges best-effort); `stopping` was
  missing from the page's transitional states (card froze).
- **`/w/<id>/` status-page hand-off** — the editor URL is safe in any state
  (provisioning/stopped/deleted show the status page; running hands off to the editor)
  — fixes the raw-URL 502/blank.
- **Editor `unauthorized` fix** — proxy now recognizes the Monaco `edd-editor-token`
  cookie; proven with an end-to-end handshake regression test.
- **Access audit + proxy denial diagnostics**, **permanent-delete of terminated
  workspaces** (type-to-confirm), **"started by" + viewable badge**, editor-type badge,
  full-page info modal, startup overlay, OpenVSCode File-menu default (golden).

Local verification on the branch is green after the PR #193 e2e fixes: `pnpm test`,
`pnpm lint`, `pnpm test:integ:local`, `pnpm test:e2e:local`, `pnpm check-deps`,
`pnpm dead-code`, and `pnpm cpd` all pass (with the existing jscpd clone report/config
warning). PR #193 CI is green, including `golden-images`; that CI job validates the
workspace image build path, but it does not publish/repoint the production catalog.
The branch was deployed control-plane-only to real AWS as image tag
`eee7176`: CodeBuild succeeded, ECS rolled to task definition revision 25
(control-plane 2/2, SSH gateway 1/1), and `scripts/install.sh --verify` is green
(ALB health 200, `/api/readyz` 200, reconciler enabled, no Terraform drift).
The production deploy used `EDD_BUILD_TARGET=web`, so it did **not** build a
production workspace/golden image for `eee7176`; the live catalog still points at
`729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:db75d1f`
(`PK=$edd#id_img-seed-omnibus`, `SK=$baseimage_1`). The latest successful image
build (#29) also built only the control-plane image tag `eee7176`; the last
observed golden-target build was #24 (`f22210e`, not catalog-selected), while the
currently selected catalog tag came from build #23 (`db75d1f`).
Remaining: apply the CodeBuild buildspec/WAF update, deploy the control-plane
source sync flow with `EDD_IMAGE_SOURCE_REPO=e6qu/ecs-dev-desktop`, create the required
`EDD_IMAGE_SOURCE_WEBHOOK_SECRET` secret, configure the GitHub webhook delivery,
and run the first control-plane-started golden build. User live-testing;
`claude`/`codex` workspace modes intentionally fail until the vendor harnesses
now explicitly chosen by the user are wired (Anthropic Remote Control /
`claude.ai/code` for Claude Code; OpenAI `codex app-server` / first-party local
client protocol for Codex).

## Real AWS production deploy — LIVE (2026-07-05/06), still hardening post-launch

The AWS account/domain decisions (`DO_NEXT.md` #1/#2) are resolved and the platform is
**deployed and verified on real AWS**: region `eu-west-1`, stack name `edd-prod`,
domain `edd.e6qu.dev` (delegated from Namecheap-registered `e6qu.dev`), GitHub OAuth
via org `e6qu-org`. `scripts/install.sh --verify` is fully green (ALB health 200,
control-plane service 2/2 healthy, reconciler schedule enabled, `/api/readyz` 200,
no Terraform drift), and GitHub sign-in is confirmed working end-to-end.

This was the first-ever real execution of the install/deploy path (previously only
shellchecked/sim-validated), and it surfaced **9 genuine bugs** across
`scripts/install.sh`, `scripts/bootstrap-secrets.sh`, `scripts/publish-images.sh`, the
Terraform module, and `apps/web/Dockerfile` — none exercisable against the sockerless
sim or via static checks alone. All fixed and verified live on
`fix/install-missing-param-logic` (pushed, **not yet merged/PR'd** — per the
one-PR-at-a-time rule, ask before opening); full detail in `BUGS.md` → Resolved (repo) and
the 2026-07-05/06 entries in `WHAT_WE_DID.md`. Highlights: an inverted parameter-validation
check in `install.sh`, a Secrets Manager eventual-consistency race, an unclosed-HCL-list
`sed` bug, a missing KMS key policy for CloudWatch Logs, a non-ASCII security-group
description, a Free-Tier-ineligible NAT instance type, a wrong Docker build context for
the SSH gateway, CodeBuild's default image lacking a modern-enough Node/glibc, a missing
`dynamodb:DescribeTable` IAM grant, and (the one affecting real users) Auth.js building
the GitHub OAuth `redirect_uri` from the container's internal ECS hostname instead of
the public domain — fixed by setting `AUTH_URL` explicitly.

**Since launch, real usage surfaced (and fixed) several more live-only issues**: a wrongly
cluster-conditioned `ecs:RegisterTaskDefinition`/`DescribeTaskDefinition` grant (blocked
every real workspace creation until fixed — verified against AWS's own IAM condition-key
reference, not guessed), `logs:DescribeLogGroups`/`ecs:DescribeClusters`/
`ec2:DescribeAvailabilityZones` gaps (`/admin/health` + `/admin/infrastructure`), and a
workspace-id validation gap a fuzz test caught on this session's first real `pnpm test`
run. Shipped two new features (persona "view as" switcher + `/me` page; a collapsible,
paginated repo browser) — both live. Then a real user hit a live-breaking golden-image bug
("editor could not be opened") — root-caused via CloudWatch logs (no exec needed) to an
`install -d` leaf-only-chown gotcha in `entrypoint.sh` leaving `.openvscode-server`
root-owned; fixed, plus AI agent CLIs (Claude Code + the previously-missing Codex) moved
to every golden variant, terminal-open-by-default + a `claude`/`codex` OAuth-redirect tip
for both OpenVSCode and the first-party Monaco editor, and explicit zero-downtime
control-plane deploy config. Golden image rebuild for these fixes is in flight as of this
writing — see `DO_NEXT.md` for what still needs live verification once it lands.

## PR #180 merged — wave-3 probes shipped, all CI green

PR #180 merged to `main` with fully green CI. Delivered: strict CloudWatch alarm SNS probe, 10 wave-3 adversarial probe slices, sockerless #767 bump (`f0d96ec3`), probe `echo`→`printf` fix, e2e OAuth scope fix (`admin:org` for provisioning).

## Active — wave-4 adversarial spec-fidelity probes

7 new probe slices for previously untested module surfaces (EC2 SG egress, DynamoDB SSE/GSI, EventBridge Scheduler, CloudWatch dashboard, ALB target group, IAM roles, CodeBuild). Boyscout: replaced all `echo "$var" | python3` with `printf` across ALL probe scripts.

**Next action:** Push and run CI.

Fixes applied to get CI green:

- `shellcheck`: replaced a fragile `A && B || C` pattern in `adversarial-slice-kms-encryption.sh`.
- `check-deps`: refreshed Node deps and the lockfile with `pnpm update --latest -r`.
- `terraform-sim`: added a CI-only `docker-compose.tier2.host.yml` host-network override so the Linux runner can reach the sockerless ALB/NLB TLS data plane, which binds on container loopback; hardened the ACM/TLS probe to resolve via the sim DNS server and retry the TLS handshake.
- `e2e-https`: corrected the bring-up step to use `docker-compose.https.yml` (azure-sim + aws-sim + bleephub) instead of only the plain AWS sim.
- `build-test`: fixed `pct()` in `@edd/demo` to guard against non-finite `maxUsd`, which a fuzz test surfaced.

Next: merge PR #180 if CI verifies green. Then return to AWS-account-gated deploy readiness.

## Prior — sockerless fidelity audit filed; real apply still decision-gated

PR #172 closed every code/docs gap blocking a real AWS deploy that didn't need a user decision. The Terraform module was already sim-apply-proven; that PR made the path from "fresh account" to "running platform" linear, fail-fast, and reclaimable:

- **Golden-image ECR path fixed** — `scripts/publish-images.sh` pushes variants to `<prefix>/golden/<variant>` (matching the repos Terraform creates as `<name>/golden/<variant>`), and the catalog seed image ref includes the `/golden/` segment. Terraform examples, the module README, the sim fixture, and CI assertions were updated to use real variant folder names (`omnibus`, `typescript`, `go`, `python`, `java`, `rust`).
- **Workspace memory default raised to 2048 MiB** — the previous 1024 MiB default was below the measured footprint of the default omnibus workspace and would OOM once Fargate enforces cgroup limits (sockerless#583). The cost-model pricing test was updated to match.
- **Dependency freshness** — `eslint`, `knip`, `@types/node`, and `turbo` were refreshed to clear the `check-deps` gate.
- **Terraform examples** (`examples/complete`, `examples/terragrunt`) wire the SSH-ingress vars (`ssh_base_domain`/`route53_ssh_zone_id`/`ssh_gateway_image`); the complete example gained SSH + golden-repo outputs; a stale "SSH CA" comment was fixed.
- **Control-plane Dockerfile** (`apps/web/Dockerfile`) builds the **reconciler bundle** too — the module runs the reconciler as the control-plane image with a command override (`node services/reconciler/dist/run.js`). One image ships both.
- **Scripts** (POSIX sh; shellcheck + sh/zsh clean; fail-fast): `bootstrap-state.sh` (versioned/encrypted S3 + DynamoDB lock, idempotent), `bootstrap-secrets.sh` (generates crypto secrets; env-or-prompt for IdP creds; headless-capable), `publish-images.sh` (build+push control-plane/golden/gateway to ECR), `install.sh` (one-command orchestrator — parametrized via env; computes the SSH-gateway image ref upfront so a one-shot SSH-enabled install works; `--verify` re-checks a stack read-only), `uninstall.sh` (full teardown, **partial-install-safe**: terraform destroy with `deletion_protection=false`, force-delete secrets, sweep leaked runtime volumes/snapshots/tasks tagged `edd:managed`, optional state purge).
- **Multi-arch image publishing convention** — `scripts/publish-images.sh` builds every image for `amd64` and `arm64`, tags per-arch images with `-amd64`/`-arm64`, and creates/pushes a multi-arch manifest at the unsuffixed tag. The golden base Dockerfile uses a `node-pty-builder` stage that compiles the native binding for the target architecture inside the image.
- **`release` workflow** (`release.yml`) — tag/manual, OIDC→AWS role, gated on `RELEASE_AWS_*` repo vars so it's inert until the account decision lands.
- **`docs/architecture.md`** — block diagram, component roles, persistence/auth models, the deployment sequence, and the browser-editor + SSH-registered-key connection sequences.
- **`docs/install.md`** — the linear parametrized runbook (set params → paste install → paste verify → cleanup), linked as the headline install path from the README.
- **Doc sweep** — fixed stale SSH-CA refs (`infra/images/README.md`), the stale "sim NLB is HTTP-only" note in the module README (the NLB raw-TCP chain is closed), stale items in `observability-gaps.md` (CONNECTION_TOKEN done, sockerless#569 fixed), completed the module README inputs/outputs tables, and cross-linked architecture/install across README/deploying/module README.

Genuinely AWS-account-gated work (real `apply`, DNS/ACM issuance, IdP federation, `e2e-aws`) is unchanged — still under `DO_NEXT.md` open decisions #1/#2.

## Prior — IAM enforcement deepened to condition keys (#660 adopted; #661 filed)

Building on the action-level enforcement proof (#657→#659), adopted sockerless **#660** — the full real-AWS
condition-operator evaluator (`Numeric*`/`Date*`/`IpAddress`/`Arn*`/`ForAllValues`/policy-variable
substitution/`Principal` matching) + STS `AssumeRole`/`GetCallerIdentity`. Re-pinned `1dc18896 → 9a1d4e92`;
backward-compat holds (full integ 25/25, since the gate still only enforces on registered IAM users).

`packages/storage-ec2/src/iam-enforcement.integ.ts` (refactored behind a shared `provisionPrincipal` helper)
now proves **two** levels: **action** (DescribeVolumes allowed, CreateVolume denied) AND **condition** — a
region-locked policy (`ec2:CreateVolume` with `Condition StringEquals aws:RequestedRegion`) allows the SAME
action in-region and denies it cross-region with `UnauthorizedOperation`. So the gate evaluates the policy's
Condition against request context, not just the action.

**Gap filed (#661):** the gate populates only GLOBAL condition keys (`aws:username`/`SourceIp`/
`RequestedRegion`), not RESOURCE-scoped ones (`aws:ResourceTag/<key>` from the target resource's tags) or
service keys (`ecs:cluster`). Our least-privilege design conditions destructive EC2 grants on
`aws:ResourceTag/edd:managed=true` and ECS grants on `ecs:cluster`, so those exact grants stay e2e-aws-only
until #661 lands. (9 sockerless issues filed across the arc; 8 resolved, #661 open.)

## Prior — IAM call-time enforcement proven at the sim tier (#657 fixed by sockerless #659)

sockerless **#659** implemented the request-time IAM authorization gate I filed as **#657**: it resolves the
SigV4 access-key id → registered IAM user → effective policy → the existing evaluator, returning the correct
per-service deny shape (EC2 `UnauthorizedOperation`, etc.). Backward-compatible — enforcement applies only to
access keys that resolve to a _registered_ IAM user, so existing tests' dummy creds stay permissive (re-pinned
`5fb1341a → 1dc18896`; full integ tier 25/25, unchanged).

So `packages/storage-ec2/src/iam-enforcement.integ.ts` now **runs** (no longer skipped): it self-provisions a
restricted principal via standard IAM APIs (`CreateUser` → `PutUserPolicy` granting only `ec2:DescribeVolumes`
→ `CreateAccessKey`) and proves the gate is **selective** — `DescribeVolumes` allowed (positive control),
`CreateVolume` denied with `UnauthorizedOperation` (negative control) — then tears the principal down.
Standard IAM+EC2 APIs only, no sim branch, so the same test certifies real AWS in `e2e-aws`. This closes the
loop: least-privilege **denial** (not just policy-text evaluation) is now proven without a real AWS account.

## Prior — IAM-enforcement gap filed (#657) + cost visualization + third sweep

Three user-requested threads in one PR:

- **IAM call-time enforcement (sim-first).** We can prove our least-privilege **policy text** denies (the
  conformant `SimulatePrincipalPolicy` preflight in `@edd/iam-preflight`), but the sim authorizes every
  service call regardless of policy (`iamEvalDecision` is wired only to the Simulate endpoint, not service
  handlers; `AuthPassthroughMiddleware` validates nothing) — so a runtime DENIAL can't be proven at the sim
  tier. Filed **e6qu/sockerless#657** (request-time authz layer) and staged a coordinate-gated **skipped**
  test (`packages/storage-ec2/src/iam-enforcement.integ.ts`): a restricted principal's `CreateVolume` →
  `UnauthorizedOperation`; skips until the restricted-principal coordinates can be supplied (once the sim
  enforces, or on real AWS in e2e-aws). Real IAM **enforcement** stays an e2e-aws certification meanwhile.
- **Cost-spend visualization.** The admin costs page gained a no-dependency, stacked proportional spend bar
  (compute/volume/snapshot) per user/session row — pure div+CSS in the house style, server-computed widths.
  Portal Playwright extended (top spender fills to 100%); 13/13.
- **Third bug/spec-fidelity/fuzz sweep.** Fixed **H1** (a benign version-conflict race was counted as
  `failed`, raising a false `CONVERGE_FAILED` reconciler alarm), **M1** (a skipped-drift term dropped from the
  metric/log roll-up), **M2** (security privilege metric double-counted without an audit ledger → now fails
  loud), **M3** (timeline dedup by string vs instant), **L1/L3/L4** (count-vs-ms parser, client-doc accuracy,
  EMF/CloudTrail fail-loud guards), and added **6 property/fuzz files** (now 20). One flagged finding (M4 —
  scheduler `ActionAfterCompletion: DELETE`) was verified a **false positive** and left unchanged; one (L2 —
  catalog last-write-wins) is recorded as an accepted admin-only limitation with a follow-up.

## Prior — DynamoDB Local retired from all CI; sim re-pinned to #655

Completed the DynamoDB-Local retirement that the integration-tier migration started. Now **every CI tier
runs against the sockerless sim's DynamoDB**: the **e2e** tier (the container-mode sim already serves it)
and **playwright** (which now brings up the process-mode sim) joined the already-migrated **integration**
tier. `@edd/config` `dynamodb.endpoint` now **defaults to the sim** (`:4566`); the `amazon/dynamodb-local`
container is gone from `tier2` + `e2e` compose and all three CI jobs. The only remaining DynamoDB-Local
consumer is the local `pnpm dev` loop (it pins `:8000` for instant startup — the CAS flake only bites under
CI concurrency, and forcing a sim build on every dev loop is a real regression; overridable to the sim).

Also re-pinned the sim `0e46585e → 5fb1341a`, adopting sockerless **#654** (DynamoDB fail-loud expressions

- spec-derived required-field validation) and **#655** (differential testing vs DynamoDB Local + CloudWatch
  fail-loud) — which together **closed the architecture meta-issue #652** (all five "silent incompleteness"
  prevention levers landed). The new fail-loud + required-field validation surfaced **no new gaps** in
  surfaces our code uses — clean adoption.

Validated: full integ tier 25/25 against the new pin + sim DynamoDB (via the config default, no env
override); portal **Playwright 18/18** against the sim's DynamoDB locally (incl. the live-DynamoDB health
board); build / lint (19) / unit (33) / knip / shellcheck / actionlint clean. The e2e tier (container-mode,
CI-only) validates in CI.

## Prior — Integration tier's DynamoDB migrated to the sockerless sim

The integration tier now runs against the **sim's own DynamoDB** (endpoint-only, `DYNAMODB_ENDPOINT` →
`:4566`) instead of the standalone **DynamoDB Local** container. This closes the long-standing
`concurrency-pairs.integ.ts` "delete vs wake" flake at its root: DynamoDB Local's weaker conditional-write
isolation could rarely let two `version == V` CAS writes both commit, whereas the sim's single global-mutex
item store serializes them — so the test is now deterministic. Per the user's "use sockerless, don't work
around" directive, getting here meant filing + getting fixed **7 sim conformance bugs** upstream (each with
a minimal AWS-CLI/SDK repro + AWS-spec citation + a `simulators/aws/*.go` code pointer):

- **DynamoDB:** #641 (TransactWriteItems dropped the `Update` action), #642 (TransactionCanceledException
  omitted `CancellationReasons`), #643/#648 (SET RHS evaluator stored `null` for the parenthesized
  `if_not_exists` arithmetic ElectroDB emits), #644 (DeleteTable didn't purge items). Fixed in sockerless
  #646/#649.
- **CloudTrail:** #650 (sim self-generated phantom `ListBuckets` from a bare `GET /` healthcheck), #651
  (`LookupEvents` returned DynamoDB data-plane ops — AWS returns management events only). Fixed in #653 via
  registration-time management-vs-data classification. Plus architecture issue **#652** (open) on the
  recurring "silent incompleteness" failure mode.

Mechanics (re-pinned to `0e46585e`): `DYNAMODB_ENDPOINT` set in the CI `integration` job +
`scripts/test-integ.sh`; `dynamodb-local` removed from `docker-compose.tier2.yml` + the CI job;
`observability-live` made isolation-robust (scoped `LookupEvents` instead of the shared capped audit feed);
`@aws-sdk/client-cloudtrail` added to `apps/web`. Validated: full integ tier green against the new pin + sim
DynamoDB (control-plane 52/52, db 5/5, web 130/130, storage-ec2 9/9, all adapters green). The container-mode
**e2e tier stays on DynamoDB Local** (it hardcodes `host.docker.internal:8000`) — its migration is a
follow-up.

## Prior — Two e2e-aws-only proofs moved onto the sim (CloudWatch Metrics + recurring cron)

Acting on the principle that a sim gap is a slice to implement, not a wall: two validations previously
labelled "real AWS only" are now sim-proven against the live sockerless sim (the sim already had the needed
support — sockerless #604 EMF extraction + the scheduler firing loop — so no upstream slice was needed):

- **CloudWatch Metrics EMF → metric extraction (Phase 8C gate closed).** New
  `@edd/cloudwatch-metrics` integ (`test/emf-metric-sink.integ.ts`): drive a real EMF document through
  `EmfMetricSink`, `PutLogEvents` it to a log group exactly as the awslogs driver would, then read it back
  through the CloudWatch **metric** APIs (`ListMetrics`/`GetMetricStatistics`) — proving our EMF shape is
  genuinely _extractable_, not just well-formed JSON. The package gained a `test:integ` script + integ
  config (auto-discovered by the `integration` CI job's `pnpm test:integ`).
- **Recurring `rate()` schedule firing (Phase 5 cron model).** New reconciler integ
  (`services/reconciler/src/scheduler-recurrence.integ.ts`): a `rate(1 minute)` EventBridge schedule fires
  its ECS RunTask target **repeatedly** (≥2 fires observed via CloudTrail `LookupEvents`) and **re-arms**
  (still present after firing despite `ActionAfterCompletion: DELETE` — a one-shot `at()` would be deleted).
  Terraform-sim already proved the production `rate(5 minutes)` schedule is _created_; the container e2e
  proved a one-shot `at()` drives the reconciler; this closes the gap that a _recurring_ schedule actually
  fires on cadence. (~2 min wall-clock — the inherent cost of two 1-minute-minimum fires on a real-clock sim.)

Verified: `pnpm build`/`test`/`lint` green; `knip` clean; both new integ suites green against the live sim.

## Prior — Second bug / spec-fidelity / fuzz sweep (newest + under-covered surfaces)

A second adversarial multi-agent sweep targeting what the first under-covered — the newest code especially
(the in-app editor proxy from #142/#143, the `@edd/iam-preflight` package, the reconciler convergence
loops) — plus an AWS-spec fidelity re-audit. 5 read-only auditors found traced bugs; fixes were applied
serially (auditors never edit) to avoid the parallel-edit stash races the first sweep hit. **Every fix has a
test; +3 `*.fuzz.test.ts` extend the property tier** (`machine-token`, `ssh`, `timeline`/`audit`). Two HIGH:

- **`verifyWorkspaceToken` fail-closed contract (security).** A string-length guard before `timingSafeEqual`
  (which needs equal BYTE length) let a multi-byte candidate THROW instead of returning `false` on every
  machine-token trust boundary (heartbeat / gateway wake / editor token); now compares on bytes.
- **Reconciler convergence resilience.** A transient compute/DynamoDB error on ONE workspace threw out of a
  per-item convergence loop and aborted the whole sweep (skipping every later step for the tick); each loop
  now isolates a throw — counts a new `failed`, logs loudly, retries next sweep (`reconciler.converge.failed`).

Plus: the editor proxy no longer forwards the Auth.js session JWT into the workspace container
(`stripSessionCookie`), the WS-upgrade timeout no longer kills idle editor tunnels, `getToken` `secureCookie`
is read from the actual cookie (TLS-LB safe), and the token redirect sets `Referrer-Policy: no-referrer`;
`git-credential` refuses a `deleting` tombstone; `runTask`/`taskState` honour RunTask/DescribeTasks
`failures[]`; `deleteVolume`/`deleteSnapshot` are idempotent; `cost-service.replaceAll` fails loud on
`BatchWriteItem` `unprocessed`; `fingerprintPublicKey` rejects non-canonical base64; timeline/audit sort by
instant; `parseLevel` anchors to a level marker; iam-preflight treats a `MissingContextValues` provisional
allow as fail-closed; `connect-info` parses its body; `sessionCost.state` is a closed set. One **known
limitation** recorded (`BUGS.md` → Open): preflight can't recover an IAM **path** from an STS ARN (degrades
safely). Verified at close: `pnpm build`/`test`/`lint` green; control-plane + web integ green on DynamoDB
Local (cost figure-equivalence preserved).

## Prior — Property/fuzz testing pins the safety-critical invariants; spec-fidelity sweep

The test suite now includes **property-based / fuzz testing** (`fast-check`) alongside the example-based
unit/contract/integ/e2e tiers: **11 `*.fuzz.test.ts`** files exercise the pure functions over generated
inputs, so the safety-critical invariants are machine-checked rather than spot-asserted. Headline invariants
now property-pinned:

- **Cost-model figure-equivalence (metamorphic).** For any split of an event ledger, checkpoint+resume
  derivation equals full-ledger derivation; billing intervals are non-negative + order-independent; the
  window-clip is idempotent + bounded; pricing is linear; the relative-window guard holds.
- **GC selection safety.** The orphan/snapshot selectors NEVER reap a referenced resource, are monotonic in
  the grace window, never reap a `retained` snapshot, and fail-safe on a malformed timestamp.
- **State machine.** transition⟺can-transition agreement, `terminated` absorbing, every UI action maps to a
  legal transition, `planConnect` totality.
- **Security-relevant parsers (fail-closed, never-throw).** `email`, `workspaceIdFromPath`,
  `decideWorkspaceAccessBySubject`, `withinWorkspaceQuota`; plus the compute-ecs (`taskDefinitionFamily`,
  `workspaceEnvironment`, `taskReady`/`taskPrivateIp`), cloudwatch-logs level/stream, apps/web
  (`parseOnDemandUsd`/`parseUsageType`, `cookieValue`, `repoOwner`), auth (`mapClaimsToRole`), and config
  numeric-env parsers.

The same sweep fixed a batch of traced bugs (compute-ecs `listWorkspaceTasks` failure-swallow that could
leak a Fargate task + EBS volume; non-idempotent `stopTask`; `taskDefinitionFamily("")` collision;
cloudwatch-logs `read()` pagination truncation; core `relativeWindow`/`deriveFleetAudit`/billing-sort
fail-loud + string-vs-instant ordering; `email` control-char acceptance; catalog `name` trim; ssh-gateway
shell wake-poll early-exit + authorized-keys HTTP-status gate; apps/web connect-info `protocol` drift,
honest `session.user.role` default, git-credential Zod contract, admin-list enrichment) — see
`WHAT_WE_DID.md` 2026-06-21 + `BUGS.md`. One item is recorded as a **deferred known model approximation**:
the cost model over-bills the live-volume line during a _stopped_-workspace teardown (sub-cent; a precise
fix needs a persisted `BillingState` schema change — `BUGS.md` → Open). Verified at close: `pnpm
build`/`test`/`lint`, `check-deps`, and `shellcheck` all green.

## Prior — Editor reachable end-to-end through the in-app proxy + reconciler IAM self-check

The browser→VS Code editor reach is now **fully authenticated end-to-end**: clicking **Open editor**
lands on the OpenVSCode workbench through the in-app path-based proxy (`app.<domain>/w/<id>/`). On top of
the Auth.js session that authorizes the proxy, the editor task is handed a **per-workspace connection token**
(defence-in-depth) and is reachable only from the control plane:

- **Connection token (defence-in-depth).** `@edd/compute-ecs` injects each workspace task's OpenVSCode
  connection token = `HMAC(EDD_CONNECTION_SECRET, workspaceId)` via Secrets Manager
  (`edd/workspace/<id>/connection`), mirroring the agent-token path (plaintext-env fallback when no secrets
  client). The proxy hands the **already session-authorized** browser the token on the initial document
  navigation (a 302 to `…?tkn=<token>`, `editorTokenRedirect` in `apps/web/lib/workspace-proxy.ts` +
  `apps/web/server.ts`); the user never sees or handles it. The HMAC derivation is centralized once in
  `@edd/core` (`deriveWorkspaceToken`/`verifyWorkspaceToken`); the compute + web call sites now share it.
- **Workspace-isolating security group.** The terraform module places workspace tasks in a dedicated
  `workspaces` security group whose editor port (`workspace_port`, default 3000) + sshd (22) are reachable
  **only from the control-plane SG** — never workspace-to-workspace. New `workspace_port` var +
  `workspaces_security_group_id` output; the control plane points workspace tasks at it via
  `ECS_SECURITY_GROUPS`, and `EDD_CONNECTION_SECRET` joined the deployer-supplied secrets list.
- **Reconciler IAM self-check.** IAM preflight moved out of `apps/web` into the shared `@edd/iam-preflight`
  package (`apps/web` imports it, dropping its now-unused IAM/STS SDK deps); the reconciler now runs
  `iamPreflight(env, "reconciler")` at startup and emits a denied-action-count metric
  (`METRIC_IAM_PREFLIGHT_DENIED`) + a structured log (non-fatal; degrades to unknown). `@edd/core` carries the
  pure `summarizeIamPreflight`/`IamPreflightSummary`.

This sits on top of the proxy foundation laid earlier today (Pomerium + the standalone `workspace-gate`
removed; the browser→editor reach folded into the control-plane app). A custom Next.js server
(`apps/web/server.ts`, run via `tsx` in dev AND prod — replaced `next start`) serves the portal/admin/API and
proxies the per-user editor at `app.<domain>/w/<id>/` (HTTP + WebSocket upgrade; logic in
`apps/web/lib/workspace-proxy.ts`):

- **Path-based routing on a single domain** (`/w/<workspace-id>/`) replaced wildcard-subdomain routing for
  the browser/HTTP path — no wildcard DNS, no wildcard TLS cert, no cross-subdomain cookie. SSH still uses
  its own `<ws-id>.<ssh-base-domain>` zone (unchanged).
- **Single auth system:** the same Auth.js (NextAuth) session authorizes the proxy, with **uid-based
  ownership** (`session.uid === workspace.ownerId`) or admin checked **in-process** — no Pomerium JWT
  assertion, no PDP `/api/internal/authz` round-trip, no gate machine-auth token, no email bridge. The
  decision is a pure pair in `@edd/core` (`decideWorkspaceAccessBySubject` + `workspaceIdFromPath`).
- The golden workspace image runs OpenVSCode with `--server-base-path /w/<id>/`; a path-based **Open editor**
  link rides the workspace card (running/idle/stopped — stopped wakes on connect). `connect-info` is now
  **SSH-only** (the in-app proxy resolves the editor upstream in-process; the SSH gateway is its only caller).
- **Removed** (clean break, no users/legacy): Pomerium (`infra/proxy/`), the `services/workspace-gate` PEP,
  the `/api/internal/authz` PDP, `pomerium-assertion.*`, the gate/Pomerium e2e + compose + the `e2e-gate` CI
  job, and the `POMERIUM_*`/`WORKSPACE_HOST_HEADER`/`WORKSPACE_AUTHZ_PATH`/`GATE_PDP_TIMEOUT_MS`/
  `workspaceGate`/`WORKSPACE_BASE_DOMAIN` config (`GATE_UPSTREAM_TIMEOUT_MS` → `WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS`).
- **Kept** (these serve the Entra-over-TLS + EBS-over-TLS e2e, not Pomerium): the SSH gateway, the
  `e2e-https` job + `gen-sim-tls-cert.sh` + `docker-compose.https.yml` (only the Pomerium-specific cert SANs
  were trimmed).

Tests: `apps/web/lib/workspace-proxy.test.ts` (authz glue — unauthenticated→login, unknown-ws→forbidden,
owner→allow, other→forbidden, admin→allow, no-subject→forbidden) + `editorTokenRedirect` unit tests (redirect
on document nav, skip when token/cookie present, skip sub-resources/non-GET, no-secret = tokenless); core
machine-token + compute-ecs connection-token env tests; `packages/e2e/src/agent-secret.e2e.ts` asserts the
`CONNECTION_TOKEN` Secrets-Manager injection; `packages/e2e/src/live-ide-flow.e2e.ts` reaches the real
OpenVSCode workbench through the IDE bridge and asserts the token the running editor uses equals the injected
per-workspace `HMAC(EDD_CONNECTION_SECRET, id)` (workbench serves only with it); the LIVE portal e2e
(`apps/web/e2e/portal-live.pwlive.ts`) asserts the **Open editor** affordance and now boots the production
custom server (`tsx server.ts`, not `next start`); the vscode browser e2e (`test:pw:vscode`) drives the
editor under the `/w/<id>/` base path. (The host-process proxy → in-VPC workspace ENI hop itself is the
e2e-aws tier — the sim runs tasks in an awsvpc netns the host can't route to.) Verified at close:
`pnpm build`/`test`/`lint` green; `actionlint` + `shellcheck` + `terraform fmt`/`validate` clean.

## Prior — UI/contract/perf/gate sweep (`feat/sweep-ui-contracts-perf`)

A 4-agent audit of the still-under-covered surface (UI/React, Zod contract tightness, 200+ scale,
gate/harness) + a type-safety pass making bad states non-representable. All fixed, no deferrals:

- **Type-safety:** tightened contracts (`quotaReport` limit→int/nonneg, role→enum; `costBreakdown`→nonneg/int;
  `sshConnectInfo.host`→min 1); `workspaceLimit` throws on a bad `EDD_QUOTA_*` override (was silent).
- **Gate (HIGH):** PDP-fetch + upstream + upgrade timeouts; upgrade-path client-close teardown before the
  upstream upgrades — closes socket-leak vectors (one PEP fronts every workspace). _(Superseded 2026-06-20:
  the standalone gate/Pomerium were removed — the editor proxy is now in-process in the Next.js app; see the
  Active section above.)_
- **Scale:** cost rollup is now regenerated on a cadence each sweep (`rollupIfStale`) so cost reads stay
  O(recent) instead of full-scanning the ledger; quota report shares the cached fleet scan.
- **Correctness:** `finishDeleting` uses `deleteRequestedAt` (not age) to decide a fresh teardown snapshot —
  no >6h stuck-teardown leak; `NewSession`/`BaseImageActions`/`usePoll` UI fixes; the ssh-authorize e2e stub
  verifies the HMAC bearer.
- **API-first:** off-contract `POST /admin/costs/rollup` now has a contract + client method.

Green through build + all unit suites + lint + shellcheck + the db/control-plane integ tiers; gate e2e + the
golden-ssh e2e (stub HMAC verify) run in CI on the PR. Noted (optimizations of correct code, not bugs):
per-sweep reconciler re-scans, the drift sweep's serial `DescribeTasks`, and the single-partition audit GSI.

## Prior — Breadth sweep (merged #140)

A 5-agent audit of the under-covered surface (gateway/proxy/auth chain, DB + cloud-adapter layer, HTTP
route surface, shell/IaC/config) — prior sweeps went deep on control-plane/cost/reconciler/storage. No
critical bypass; a set of genuine MEDIUM/LOW bugs, all fixed (no deferrals), each tested where applicable:

- **auth:** `mapClaimsToRole` now matches groups case-insensitively (a casing mismatch silently downgraded
  roles); `github-teams` follows all `/user/teams` pages (a later-page admin team was dropped).
- **routes:** `base-images` POST no longer masks 500s as 409 / leaks the error message; `github/repos` POST
  maps a 422 name-collision to 409 (was a bodiless 500); `connect-info` authenticates before validating +
  returns 409 (not 404) for an unbound-host running workspace; `pomerium-assertion` requires `exp`.
- **adapters (fail-loud):** `toLogLine` throws on a missing timestamp (no epoch mis-date); EMF guards a
  dimension/metric-name collision; `db.ensureTable` waits for ACTIVE.
- **misc:** `api-client.connectInfo` gained the `protocol` arg; `cli status` gates its exit code on cluster
  health; `withObservability` guards the header set; both `authorized-keys.sh` hops gained a charset guard
  before JSON interpolation (a `/run/edd-env` group-restriction was reverted — sshd command sessions don't
  carry a shared supplementary group, so it broke the gateway wake).

Green through build + all unit suites + lint + shellcheck + the db/control-plane integ tiers; the gateway
e2e + route integ run in CI on the PR.

## Prior — Resiliency + correctness sweep (merged #139)

A 5-agent audit (resiliency/concurrency, correctness/cost-model, types/fail-loud/telemetry,
test-fidelity, security/data-safety) found a tight set of genuine bugs — all fixed (no deferrals),
each with tests; plus this PR folds in the sockerless #629/#630 fidelity record + the submodule re-pin to
`693b39a7` (confirmed downstream):

- **HIGH data-loss on delete:** `snapshotStale` ignored snapshot age, so deleting a `running` workspace
  with a stale snapshot lost the live volume's newer work; now age-aware → `finishDeleting` takes a fresh
  retained snapshot of the live volume.
- **HIGH retained-snapshot leak:** `finishDeleting` re-created (never-GC'd) retained snapshots on a
  transaction-cancel retry; now records the snapshot id on the tombstone → idempotent re-run.
- **HIGH credential over-scoping:** GitHub-App `gitCredential` fell back to an unrelated org's installation
  when the repo owner had none; now fails closed.
- **MEDIUM retain-tag race:** `tagSnapshotRetained` confirms tag visibility before unreferencing the
  snapshot, closing the GC eventual-consistency window.
- **sockerless fidelity:** #629 (`ListSecrets` tag-key) + #630 (`ListTaskDefinitions` sort/status) filed,
  fixed upstream (#631), re-pinned + confirmed (integ green); IAM/STS/ECS surfaces verified conformant.

Green through build + all unit suites + lint + the control-plane/storage-ec2/compute-ecs integ tiers; the
container-mode e2e runs in CI on the PR.

## Prior — Deferred-cleanup PR (merged #138)

Closes the remaining deferred items from the code-quality sweep in one PR (built as committed chunks,
green through build + all unit suites + lint; integ/e2e run in CI). The user chose "bill until teardown
completes" for the billing-semantics decision:

- **Weak-type service signatures:** `SshKeyService`/`GitCredentialService` public methods take branded
  ids (`OwnerId`/`SshKeyId`/`SshPublicKey`); `ownerForKey` returns branded ids; a closed `GitProviderId`
  union replaces the bare provider string (named to avoid the existing `GitProvider` interface clash).
- **Port contracts:** `storageProviderContract` gained a `{dataIo}` gate so its control-plane subset runs
  against the real `Ec2StorageProvider` (integ); a new `computeProviderContract` runs against the fake
  (tier-1) and the real `EcsComputeProvider` (container-mode e2e).
- **Snapshot retention (Middle policy):** the teardown data-safety snapshot is RETAINED via an
  `edd:retain` tag (storage port `createSnapshot({retain})` + `tagSnapshotRetained`) and a GC keep-set
  (`selectOrphanSnapshots` spares retained snapshots).
- **Quota-drift self-heal:** a reconciler sweep (`reconcileOwnerCounts`) corrects a drifted per-owner
  counter against actual records, emitting `reconciler.quota.drift_corrected`.
- **Billing-to-teardown:** the cost model gained a fourth **teardown** phase — `session.delete` opens it
  (volume+snapshot bill, no compute), a new `session.terminated` (emitted atomically by `finishDeleting`)
  closes it; threaded through the rollup + DB entity + contract, figure-equivalence preserved + extended.

Deferred (one item, tracked in `BUGS.md`): a UI Open/Connect affordance — gated on the proxy-domain config
(DYNAMIC wake-gate territory).

## Prior — IAM permission self-check + identity (merged #133)

The app now understands the IAM actions each component needs and checks it holds them (user request).
`@edd/core` carries `IAM_REQUIREMENTS` — the per-component (control-plane, reconciler) required-action
manifest (single source of truth, derived from `iam.tf`, with the `ecs:cluster`/`ResourceTag`/
`PassedToService` condition context) — plus pure `evaluateIamPermissions`. The control plane runs a live
`sts:GetCallerIdentity` + `iam:SimulatePrincipalPolicy` preflight over its OWN identity (endpoint-only,
fail-fast, degrades to `unknown` off real AWS), folded into the config-sync report as an
`iam-permissions:control-plane` check. The resolved **caller identity** (account + principal ARN) is
surfaced via the report → admin Infrastructure card, `/api/admin/config-sync`, the api-client, and the
`edd config-sync`/`doctor` CLI. A **CI drift gate** (static test) asserts the terraform policy grants ⊇
the manifest per role; terraform-sim gained a live self-check assertion. Terraform: control-plane role
gained read-only `iam:SimulatePrincipalPolicy` + `sts:GetCallerIdentity`. Reconciler runtime preflight
(no UI/API) is a noted follow-up — its grants are covered by the manifest + CI gate. The user confirmed
both the hybrid verification approach and the CI drift gate.

## Prior — Adopt sockerless #621 (merged #132)

Sockerless **#621** (merge `47b6a2a`) landed validation for both fidelity-slice-2 gaps. Re-pinned the
submodule (`322d16ad` → `47b6a2a`), rebuilt the process-mode sim, and **confirmed downstream** (all four
cases now reject with the AWS-spec error; valid-form controls still pass). #618/#619 closed upstream;
**no open sockerless blockers remain** (aside from the deliberate #583 memory-sizing gate).

## Prior — Sockerless fidelity slice 2 (PR #131, merged)

A second adversarial conformance sweep (process-mode sim `322d16ad`, standard AWS SDK v3, judged vs the
documented AWS spec) of the surfaces our code drives but slice 1 (#590/#591/#592) hadn't reached: ECS
`RegisterTaskDefinition`/`RunTask`/`DescribeTasks` validation, EventBridge Scheduler `CreateSchedule`,
CloudWatch Logs pagination, Secrets Manager error shapes. Filed two genuine under-validation gaps upstream
(**#618**, **#619**; both now fixed by #621). Also reconciled `BUGS.md`: moved the codex Phase-9 findings
(merged #129) from Open → Resolved after re-verifying all 12 against the merged code.

## Prior focus — Self-recovery + monitoring (PR #130, merged, codex-advised)

Four user-requested themes built together on `feat/self-recovery-and-monitoring` (PR #130), after a
codex self-recovery review synthesised with our own analysis and four design decisions confirmed with
the user (one bundled PR; desired-state + tombstone async delete; Middle data-safety; live config
self-check now):

1. **Self-recovery / convergence.** Durable intent (`desiredState` present/deleted) + a `deleting`
   tombstone makes an interrupted delete resumable. New pure fns `markDeleting` / `markRecovered`
   (error→stopped only with a snapshot) / `markSnapshotLost` / `isUnrecoverable`. `remove()` CAS-marks
   the tombstone (DELETE → **202**); the reconciler's `finishDeletions` / `recoverErrors` /
   `detectStorageDrift` sweeps (budget-bounded, `DEFAULT_CONVERGE_BUDGET=50`) converge toward intent,
   snapshot-before-destroy in `finishDeleting`.
2. **Functional usability checks.** idle-agent `functional_body()` probes the IDE port + a writable
   HOME, folded into the heartbeat → `functional` ok/degraded surfaced in admin Inspect + a metric.
3. **Privilege/security warnings.** In-image `edd-privilege-guard.sh` shims docker/sudo/etc. → friendly
   message, structured stderr log, best-effort POST → first-class audit event + `security.privilege_attempt`
   metric; alarm `security-privilege-attempts`.
4. **Config-sync self-check.** Pure `evaluateConfigSync` → `/api/admin/config-sync`,
   `api-client.adminConfigSync`, an Infrastructure-page card, and a new thin **`@edd/cli` `edd` CLI**
   (`edd config-sync` / `doctor`) over the SDK.

**Status:** all CI jobs green except `e2e`, whose only failure is the known heavy `pw:vscode`
keystroke-landing flake (the keyboard burst dropped before xterm attached; unrelated to these changes —
the privilege-guard shims cover docker/sudo, not the Go toolchain). Re-triggered the `e2e` job.

## Prior focus — Phase 9: code-review remediation (codex 2026-06-19, merged #129)

A deep `codex` review (read-only; model `gpt-5.5`) produced 12 findings, 4 independently re-verified,
all actionable without the AWS account decision — 4 Critical (silent prod fake-provider fallback;
terraform IAM missing the agent-secret create/inject path; workspace exec/task role ARNs never passed;
SSH-key uniqueness race), 3 High (no early snapshot → fresh-workspace data loss; hidden
repo-clone/git-credential failures; un-GC'd per-workspace secrets), 4 Medium/Low. The previously-parked
cross-region EBS snapshot DR flow was pulled in (sim-validatable via sockerless#602); only genuine
real-AWS work stays under open decision #1. Merged as **#129**.

## Prior phase — user-registered SSH keys + per-workspace SSH subdomain (Phase 4b)

**In progress — user-registered SSH keys + per-workspace SSH subdomain (Phase 4b).**
The user asked for: each user inputs their SSH key, and SSHes into each running
workspace at its own subdomain. Confirmed design: SSH is **registered-key only** —
both the human→gateway hop and the internal gateway→workspace hop authenticate by
the user's **registered public key** and authorize the workspace by **ownership at
connect time** (`ssh-authorize`). There is **no SSH CA and no certificates** — the
CA path was fully removed in a clean break (we carry no legacy; mid-development).
Routing is wildcard-DNS → one public gateway (stock OpenSSH; the workspace id rides
in the subdomain/username since SSH has no SNI). **Slices 1+2 landed on `feat/ssh-key-registration`:**

- **Slice 1 (foundation):** branded ids + pure `fingerprintPublicKey` (matches
  `ssh-keygen -lf`) + `workspaceSshHost`/`isWorkspaceLabel` (`@edd/core`);
  register/list/delete contracts (`@edd/api-contracts`); the `sshKey` ElectroDB
  entity with a `byFingerprint` GSI + global key uniqueness (`@edd/db`);
  `SshKeyService` (register/dedup/list/ownership-delete/`ownerForKey`)
  (`@edd/control-plane`).
- **Slice 2 (API + portal):** `/api/ssh-keys` CRUD + the gateway connect-time
  decision endpoint `/api/workspaces/:id/ssh-authorize` (machine-auth; authorize iff
  the key is registered to the workspace owner) — the seam the gateway will call;
  api-client methods; Settings → SSH keys page; per-workspace `ssh …` command on the
  workspace card (when `EDD_SSH_BASE_DOMAIN` is set); `SSH_BASE_DOMAIN` config.

Verified: core+contracts unit green (173), service+entity + route integ green on
DynamoDB Local (ssh-keys CRUD/conflict/isolation + ssh-authorize
owner/mismatch/unregistered/no-token), web typecheck+lint+offline build green.
**Slice 2c complete — dual-trust SSH, docker-e2e validated** (chosen over a
terminating bastion; no Teleport — same public surface either way, and dual-trust
keeps VS Code Remote-SSH/scp/forwarding). Both sshds authorize the **same registered
key** via `ssh-authorize` (the gateway with its token, the workspace with its agent
token). On `feat/ssh-dual-trust`: `ssh-authorize` accepts both tokens; the **gateway**
sshd and the **golden image** both authorize via `AuthorizedKeysCommand`. The
`ssh-proxy.e2e.ts` was rewritten self-contained (worker-thread stub control plane +
docker-run node + proxy) and **validated 2/2 green**: a registered key is authorized
at both hops and lands on the node, an unregistered key is denied.

**Clean-break CA removal complete (2026-06-17, `feat/ssh-registered-key-only`).**
With dual-trust proven, the entire SSH-CA path was deleted — no additive shim, no
legacy: the `/ssh-cert` route + `lib/ssh-cert.ts`, the `sshCert*` contracts +
api-client method, `scripts/gen-ssh-ca.sh`, `docker-compose.ssh.yml`, the
`EDD_SSH_CA_*` config + compute-provider env injection, the Terraform
`ssh_ca_public_key` var **and** its #108 half-config precondition, and all CA wiring
from the golden/gateway/node images. The cert-based e2e suites were migrated to
registered keys: `golden-workspace-ssh` + `data-durability` use an in-process
`ssh-authorize` stub control plane; `user-journey` registers an account key via the
API; `ssh-wake-chain` registers a key and proves the gateway wakes a STOPPED
workspace through the **real** control plane (landing-on-node stays covered by
`ssh-proxy`). Docs + the architecture table + the `EDD_SSH_CA_KEY` deploy secret
were all updated. CI builds `edd-workspace-node:e2e`. **Only Slice 3 left —
public SSH NLB + Route53 `*.ssh` (AWS-gated, decision #1).** See `PLAN.md` §4b.

**Catalog and session-launch UX cleanup are now part of the current mainline state.**
The golden-image collection remains fully complete — the base/omnibus split + slim
variants (#97/#101/#102/#103), the fuller per-language tooling (#104), and both
post-#104 follow-ups (#105). The latest completed pass was a broader
**catalog/admin UX refactor** layered on top of the catalog metadata picker:

- base-image catalog entries carry structured **tags** + **tool highlights** end to end;
- the new-session launcher uses a card-based environment picker with that metadata;
- catalog management moved into the admin IA at **`/admin/catalog`** (the legacy
  `/base-images` route redirects there);
- `/workspaces` no longer presents a competing inline creator — session creation is
  unified around `/sessions/new`;
- workspace/admin lists now show catalog display names and stronger environment context
  instead of mostly opaque ids/image refs;
- top-level nav now has active-state location awareness, and the admin shell has better
  narrow-width behavior;
- the catalog form is labeled/grouped like an operator tool rather than placeholder-only.

Also folded into the same pass while chasing unrelated but live issues proactively:
(a) the web app no longer depends on `next/font/google`, so `pnpm --filter @edd/web build`
works offline/in-sandbox; the typography now comes from local/fallback family variables in
`globals.css`. (b) `waitForDynamo()` now fails **before** Vitest's hook timeout with an
explicit endpoint-bearing error (`DynamoDB at http://127.0.0.1:8000 did not become ready
within 10000ms`) instead of opaque 30s hook timeouts when DynamoDB Local is absent.

Verification for this state included real local DynamoDB-backed runs (outside the
sandbox where loopback access was permitted): `@edd/web` targeted integ green,
control-plane catalog integ green, and the full portal Playwright suite green
**13/13**. Local static verification also stayed clean:
`@edd/{api-contracts,db,core,control-plane}` builds green;
`@edd/{db,core,control-plane,web}` lint green; `@edd/web build` green.

After that pass, the dependency-freshness gate moved again: `check-deps` flagged
`vitest` and `@playwright/test` as behind the latest age-eligible versions. Both
were refreshed (`vitest 4.1.8 → 4.1.9`, `@playwright/test 1.60.0 → 1.61.0`), the
pnpm lockfile was updated, `pnpm check-deps` returned clean again, and local
verification re-confirmed a representative Vitest target plus the full portal
Playwright suite green **13/13** on the newer browser stack.

One more CI follow-up surfaced after that: the **live** portal Playwright spec
still automated the removed `/workspaces` inline `<select>` creator. The live test
now drives the current `/sessions/new` launcher instead (catalog picker card +
`blank session`), matching the merged UX. Local verification for the fix covered
type-checking plus the standard portal Playwright suite green **13/13**; the full
container-mode live harness remained a CI-only repro in this shell.

A `BUGS.md` follow-up was then resolved: confirm sockerless#569 (managed-EBS
`RunTask` panicked the process-mode sim) downstream. Confirmed fixed — against the
re-pinned sim (`c69cd278`) the managed-EBS `RunTask` now returns a task ARN and the
sim stays healthy through the async EBS transition where it previously crashed. The
note's "re-enable a process-mode managed-EBS `RunTask` in the lightweight
`integration` job" was itself misframed: the `integration` tier is the API-surface
process-mode sim with **no container runtime** (CLAUDE.md §5), so a workspace
`RunTask` cannot reach RUNNING there and asserting otherwise would be a
target-specific assertion (§6.9). That path is — correctly — covered in the
container-mode `e2e` tier (`agent-secret.e2e.ts`, workspace-lifecycle, user-journey).
`BUGS.md` was updated to mark #569 confirmed and close the follow-up; no code change.

(A second stale note about `EDD_SSH_CA_KEY` Terraform provisioning, and the #108
half-config `precondition` added to guard it, are now moot — the entire SSH-CA
path was removed in the 2026-06-17 clean break above. There is no CA secret, no
`ssh_ca_public_key` var, and no precondition to provision or guard.)

## Prior phase (merged, #105)

**Golden-image follow-ups: Java formatter + agents omnibus-only.** (a) **Java
formatter** — added `google-java-format` (the de-facto Java formatter; JAR +
`/usr/local/bin` wrapper) to **java**+**omnibus**, so every language variant now has a
format CLI; version resolved via the github.com `releases/latest` redirect (not the
rate-limited api.github.com). (b) **Agents omnibus-only** — moved the AI agents (Claude
Code + Codex extensions + the `claude` CLI, ~1 GB native) OUT of **base** into
**omnibus only**, so the slim variants drop ~1 GB each (base ~1.8→~0.9 GB; typescript
~2.2→~1.3, python ~3.6→~2.7, go ~1.4, java ~1.7, rust ~1.8); a slim-variant user
installs the agents at runtime via the user-CLI path (#90/#91). Tests: `image-variants.
e2e.ts` asserts agents ABSENT in slim variants + java has google-java-format;
`workspace-toolchain.e2e.ts` keeps the omnibus agent assertions (now genuinely
omnibus-sourced) + adds google-java-format. (Local verification was hampered by a
podman tag-reversion/GC quirk; CI built fresh and went green 5/5 + omnibus.)

## Prior phase (merged, #104)

**Golden-image fuller per-language dev tooling (#95 follow-ons).** Rounded out the
curated dev-tooling set so a workspace matches CI out of the box. Added the
cross-cutting **Trivy** security scanner to **base** (the repo CI's own gate tool —
every variant inherits it; single binary to `/usr/local/bin`, vuln DB fetched lazily);
the **Go** dead-code/CPD/static set to **go**+**omnibus** (`staticcheck`, `deadcode`,
`dupl` alongside golangci-lint, all `go install` → `GOBIN=/usr/local/bin`); and
**cargo-audit** (Rust SCA/security) to **rust**+**omnibus**. Tests extended:
`image-variants.e2e.ts` (go asserts the trio, rust asserts cargo-audit, every variant
asserts trivy) + `workspace-toolchain.e2e.ts` (omnibus asserts all). Also **re-pinned
the sockerless submodule** `1ca1f71 → c69cd27` (picks up #569's process-mode managed-EBS
panic fix + later cells). Known remaining gap: **Java** has the JDK/Maven/Gradle +
`redhat.java` extension but no standalone formatter/linter CLI — flagged.

## Prior phase (merged, #103)

**Golden-image collection — AI agents + curated dev tooling (PR D; #93 + #95).**
Completed the collection. **base** now bakes
the **AI coding agents** (Claude Code + Codex extensions + the `claude` CLI) and the
cross-cutting JS/TS tooling that matches our CI (prettier/eslint/knip/jscpd + their
extensions). Each **variant** adds its language tooling + extensions: python
(ruff/ty/vulture/bandit/semgrep + Python/Ruff/ty/basedpyright/Semgrep exts), go
(golangci-lint + golang.go), java (redhat.java), rust (clippy/rustfmt +
rust-analyzer); **omnibus** carries them all. Key mechanism: extensions can't be
baked into the EBS-shadowed home extensions dir, so they're installed into
OpenVSCode's **built-in** extensions dir (`/opt/openvscode-server/extensions`) at
build — loaded read-only with **no runtime copy** (a ~1 GB first-boot copy slowed
task startup and caused live-sim timing races) and surviving the mount; users still
install their own into the volume dir. Dev-tool CLIs go to system paths
(`uv` → `/usr/local/bin`, `go install` → `GOBIN=/usr/local/bin`) to survive the
mount; the IDE bridge retries token extraction (a task is ECS-RUNNING before
OpenVSCode execs). OpenVSCode Server defaults to **Open VSX**, so `--install-extension`
works with no gallery config. Verified: all 7 images build; `image-variants.e2e.ts`
5/5 + `workspace-toolchain.e2e.ts` 12/12 + `live-ide-flow`/`user-journey` re-green.
Size note: the
baked agents (~1 GB native) live in base → every variant carries them (typescript ~2
GB … omnibus ~5.7 GB); flagged for a possible opt-in later. **Golden-image collection
plan complete** (PRs A–D).

## Prior phase (merged, #102)

**Golden-image collection — slim per-language variants.** Five lean variants `FROM
base` (typescript/python/go/java/rust), `dev-bootstrap` seeds the collection, the
`image-variants.e2e.ts` smoke test, and a path-gated `golden-images` CI workflow.

## Prior phase (merged, #101)

**Golden-image collection — base/omnibus split.** Refactored the single image into a
shared `infra/images/base` (runtime + the #90/#91/#94 fixes, no toolchains) + `omnibus`
(`FROM base` + full toolchain, == the previous image, tagged `edd-workspace:e2e`).
Composable PATH drop-ins; build-time system `npm i -g` forced to `/usr/local` (the
home `NPM_CONFIG_PREFIX` is inherited). Verified via toolchain + live-IDE-flow e2e.

## Prior phase (merged, #97)

**Golden-image workspace UX fixes (#90/#91/#94).** A fresh workspace is usable from
the in-browser terminal: non-root `npm install -g` works (npm prefix → HOME dir),
user CLIs on PATH across the shell matrix (image ENV + profile.d + sshd `SetEnv`),
and the editor defaults to Dark mode (entrypoint first-boot seed). These now live
in the shared `base` (PR B). Key nuance: anything under `$HOME` baked at build is
shadowed by the EBS volume mount → seed at first boot or use a system path.

## Prior phase (merged, #89)

**End-to-end live IDE flow, tested in CI on Linux and macOS.** On
`feat/live-ide-flow-ci`: brought the whole stack up against the container-mode sim
with a real ECS cluster and proved "create a workspace and open its IDE" — the
control plane launches a workspace as a real ECS task (managed EBS + awsvpc ENI;
container mode is unaffected by sockerless#569), and the **actual OpenVSCode
workbench** opens through a new IDE bridge (`packages/e2e/src/ide-bridge.ts`): the
sim isolates each task's awsvpc netns (not attached to any host-reachable Docker
network), so the bridge tunnels host → `docker exec` → the task netns → `:3000` and
extracts the per-boot connection-token. It is the local/sim realisation of the
production identity-aware-proxy reach (the CONNECTION_TOKEN handoff stays the future
product extension). New `live-ide-flow.e2e.ts` asserts create → 403 token gate →
200 workbench; `live-sim-run.ts` is a one-command interactive harness that
auto-creates a workspace, bridges it, and prints the web and IDE URLs. CI: the e2e
runs every PR in the Linux `e2e` job; a gated `e2e-flow-macos` job
(`macos-15-intel` + colima — Intel is required, Apple-silicon runners can't boot
colima's VM; `workflow_dispatch` or the `ci:macos` PR label, to bound expensive
macOS minutes) runs the identical flow on macOS. Both container images (the 3 GB
golden workspace + the from-source AWS sim) are built once natively on Linux and
pushed to GHCR (a `macos-images` job); the macOS job pulls and runs them with
`--no-build` — building under colima is far too slow (the sim build alone took
~55 min) and the golden image needs BuildKit the legacy builder lacks. The GHCR
packages are **ephemeral CI fixtures, not releases**: named `edd-ci-*`, tagged
run-scoped (`ci-<run_id>`, rebuilt from PR code every run, never reused/stale),
and labelled "NOT a release". (There is no release pipeline in the repo.) Verified locally (3 green runs; task
container observed live). Known quirk: sim task containers are reaped after a few
idle minutes — irrelevant to the fast e2e, flagged for the focused sim-fidelity pass.

## Prior phase (merged, #88)

**Admin Infrastructure view + provisioning failure as a handled 503.** (1) A
compute-launch failure is now a **handled** condition: `create()` throws a typed
`ComputeUnavailableError` (route → 503) and `start()` returns the new `unavailable`
domain error (→ 503); `withObservability` observes-and-re-raises (only genuinely
unexpected errors are 500); the api-client tolerates an empty/non-JSON error body;
`dev-bootstrap` seeds the full golden catalog. (2) New `/admin/infrastructure`
aggregate — dependency status checks, the live ECS cluster (`clusterInfo()` via
DescribeClusters; the fake reports its in-memory equivalent), fleet metrics, and
the **component topology** (`SYSTEM_TOPOLOGY` pure graph in `@edd/core` with live
health overlaid; boundary/dynamic nodes `unknown`, never a fabricated `ok`). New
`InfrastructureService` shell, contracts + api-client method, route/page/nav, and
Playwright coverage; live-view polling shared into a `usePoll` hook + `HealthRows`/
`HealthHead`.

## Prior phase (merged, #87)

**Docs accuracy pass — run-everywhere story.** Reviewed all docs against current
code and fixed drift: the README now frames the run spectrum (local fakes → local
sims → cloud via the Terraform module) and uses `edd.localhost`;
`docs/running-locally.md` gained the missing `+ Entra` command (with the HTTPS
caveat); `docs/deploying.md` split env into `secret_environment` vs
`extra_environment`, fixed the FARGATE/`golden_repository_urls` nits, and the SSH CA
material default; the module README inputs/outputs tables gained the alarm vars + 5
missing outputs; and the `examples/complete` composition now wires
`extra_environment` (so `EDD_ADMIN_GROUPS` is settable) with a fuller tfvars
example. `terraform fmt`/`validate` clean.

## Prior phase (merged, #86)

**Local dev login UI (seeded users) + `edd.localhost` cookie isolation.** Replaced
the hand-edit-cookies dev-auth flow with a real `/login` form (gated on
`EDD_DEV_AUTH=1`): pick a seeded account + password. The accounts are
**configuration, not app code** — `@edd/config` `devUsers()` parses `EDD_DEV_USERS`
(JSON) with a built-in default set (admin/member/viewer), and every account now
has an explicit `password`; missing configured passwords fail loudly. Server
actions set host-only `edd-dev-*` cookies (scoped to `edd.localhost`, so other
localhost apps' cookies aren't disturbed) and a dev-aware sign-out clears them.
Playwright tests (`e2e/login.pw.ts`) sign in via the form as each role and assert
role-appropriate access (admin reaches the console; member/viewer denied;
wrong-password rejected; sign-out clears). Also: `pnpm reap` now actually tears
down profile-scoped sim containers (it was skipping `--profile` services), and a
reusable `pnpm --filter @edd/web screenshot` captures the dev UI. Verified live
against the sockerless tier (`pnpm dev` + `EDD_DEV_PROFILES=aws`).

Also folded into this PR (CI surfaced the recurring flake): **wake-on-connect
claim-before-launch** — the wake path persists the `stopped → provisioning` claim
(version CAS) before launching, so a burst of concurrent connects starts exactly
one task and the rest wait for it, instead of N launched-then-compensated tasks (a
thundering herd that intermittently overran the sim). Two-phase domain
(`markWaking`/`markProvisioned`), a `provisioning → stopped` rollback transition,
strict `start()` + idempotent `connect()` re-dispatch. Proven deterministically in
the integ tier (N concurrent wakes → one launch, all running).

## Earlier (merged, #85)

**Observability completion — the remaining launch-readiness gaps, in one PR.**
Building on the #84 audit, closed everything actionable left in
`docs/observability-gaps.md`: (1) a `withObservability` route wrapper emits
per-request latency/status/error metrics + a structured access log across all
business API routes; (2) the reconciler emits fleet gauges (total/running/stopped/
active) + a priced `fleet.cost.usd` each sweep; (3) reconciler health is real — a
heartbeat record + `reconcilerHealthFromHeartbeat` staleness check replace the
hardcoded `unknown` on the board; (4) the admin Logs view filters the container
stream to one workspace (`?workspaceId=` → task log-stream prefix); (5) SSH-cert
issuance accepts the CA private key as material via `EDD_SSH_CA_KEY` (Secrets
Manager ARN — the secure default, never in Terraform state). All coordinate-driven
and unit/integ-tested. The one substantial item left is **`e2e-aws`**, external —
blocked on the AWS account decision (open decision #1).

## Earlier (merged, #84)

**Docs review + launch-readiness audit.** Reviewed all docs and made them
navigable and accurate: surfaced previously-orphaned docs (`admin-ui-design`,
`infra/images`, `infra/proxy`, `services/ssh-gateway` READMEs) in the README index;
added a full AWS deployment runbook (`docs/deploying.md`); made the
`docs/running-locally.md` tier commands runnable; inventoried the
logs/health/status/metrics/testing gaps in `docs/observability-gaps.md` and closed
the headline ones — `/api/readyz` readiness probe, storage Health-board check,
structured logging, a metrics layer (`@edd/cloudwatch-metrics` EMF) with CloudWatch
alarms, and CloudTrail audit pagination.

## Earlier (merged, #83)

**On `feat/ecs-exec-datachannel-proof`:** the container-mode ECS Exec coverage now
proves the command path, not just the `ExecuteCommand` response shape — opens the
returned SSM WebSocket, sends the standard `OpenDataChannel` handshake, runs a
marker command, and asserts it in the streamed AgentMessage frames. Also hardened
the control-plane AWS clients (ECS/Secrets/EC2) to adaptive retry (`maxAttempts=6`)
so concurrent wake-on-connect bursts don't surface a transient `RunTask` 5xx.

## Earlier (merged, #82)

**On `feat/aws-price-list`:** accurate costing now sources rates from the **AWS
pricing model directly** — live from the AWS Price List API (`pricing:GetProducts`)
for the deployment's region (`apps/web/lib/aws-pricing.ts`), opt-in via
`EDD_AWS_PRICING=1`, best-effort with per-rate fallback to the configured
`@edd/config` rate (so a missing/denied API never mis-prices). The pure parser is
unit-tested against a recorded GetProducts shape; the live fetch has no simulator
(no Pricing API) so it's exercised against real AWS (`e2e-aws`), CI uses the
fallback. Formula unchanged (Fargate vCPU/GB-hr + EBS/snapshot GB-mo).

## Earlier (merged, #81)

**On `feat/cost-rollups`:** the cost report moves from O(history) to O(recent)
without changing the figures. New pure core (`deriveBillingState`/`resumeBilling`,
46 figure-equivalence cases) lets the report price each workspace by resuming a
persisted checkpoint + replaying only the events since it; a `costRollup` DynamoDB
entity (reuses GSI1, no table change) + `StoredCostRollupStore` + `CostService.rollup()`
(admin trigger `POST /api/admin/costs/rollup`) persist/regenerate the checkpoints;
`report()` uses them when present, else the exact full scan. Proven byte-identical
to the full scan against DynamoDB Local (`cost-rollup-equivalence.integ.ts`).
Pricing uses the AWS on-demand **model** (Fargate vCPU/GB-hr + EBS/snapshot GB-mo,
us-east-1 rates, `EDD_PRICE_*`-overridable); live region-accurate rate sourcing via
the AWS Price List API is the next (real-AWS-validated) follow-up — `BUGS.md` → Open.

## Earlier (merged, #80)

**On `feat/ecs-secrets-health-cost-exec`:** an ECS hardening sweep clearing the
remaining Open compute items:

- **Agent token → Secrets Manager (security).** `runTask` stores the per-workspace
  HMAC agent token in a Secrets Manager secret and references it from a
  per-workspace task def's container `secrets`, instead of plaintext
  `environment` (which surfaced in DescribeTasks/CloudTrail). ECS resolves it into
  the container env at launch. Container-mode e2e (`agent-secret.e2e.ts`) +
  user-journey heartbeat prove it.
- **Real `health()`.** DescribeClusters-backed compute health (ACTIVE→ok), closing
  the inverted contract (board showed `unknown` on AWS). Process-mode integ.
- **ECS Exec on the launch path.** `runTask` sets `enableExecuteCommand: true`.
- Found + filed a sim bug (**sockerless#569**): process-mode RunTask with managed
  EBS panics (nil Docker client), so the secret/runTask path is validated in
  container mode (not the process-mode `integration` job).

Done since: **cost-report time-windowing** — `/admin/costs?window=all|1d|7d|30d`
scopes the report to the last N days (pure interval-clipping in `@edd/core`; the
lifetime path is byte-identical, so the rollup figure-equivalence invariant is
untouched). The feared "sizable bucketed-rollup subsystem" was unnecessary —
clipping the lifetime intervals to the window is exact. Still deferred:
`CONNECTION_TOKEN` injection (lands with the future DYNAMIC wake-on-connect gate
it's tied to).

## Earlier (merged)

**`runTask` readiness gating (#79):** `runTask` waits for the task to be READY
(`taskReady`: RUNNING + managed-EBS volume + ENI) before returning, so the control
plane never advertises a workspace that can't yet accept connections.

**On `feat/sim-probe-coverage`:** a sim-probe coverage pass — added a
**multi-generation EBS snapshot-chain** probe to `packages/storage-ec2/src/ec2-storage.integ.ts`:
snapshot a volume that was itself hydrated from the previous generation's snapshot,
twice, asserting per-generation snapshot→source lineage and restore-from-a-restored-
snapshot. This is the scale-to-zero persistence loop over repeated idle cycles at the
EC2-API layer. The sim handles it correctly (probe green) → no upstream gap to file.
The §6.9 storage filter comment is current (the stale workaround was removed in #74).

**Prior phase (merged, #77):** the **live per-workspace-authz chain** (increment-2 /
DO_NEXT #5) — the PEP→PDP decision proven in the real Pomerium routing path.

The #77 chain also found+fixed a real PDP bug (the proxy preserves a non-default
`Host` port while Pomerium binds the assertion `aud`/`iss` to the bare hostname → the
PDP now authorizes on the port-stripped hostname) and a gate `Dockerfile` missing
`@edd/core`; it standardized the local app port 3000 → **3700**.

**Earlier (merged):** a **GitHub App** provider behind a new
`GitProvider` seam, plus a new architectural principle. `apps/web/lib/github.ts`'s
token-parametrized functions become `UserOAuthGitProvider` (default), joined by an
`InstallationGitProvider` that signs an RS256 app JWT (`jose`) → mints an
installation token (`ghs_…`) → installation-scoped REST. `getGitProvider(ownerId)`
selects by config (`EDD_GITHUB_APP_ID` + `EDD_GITHUB_APP_KEY` → App mode, else the
user's stored OAuth token); the repos/namespaces routes + the clone/push broker go
through it (the broker picks the installation by the repo's owner). The git
credential is wire-identical (`x-access-token` + bearer), so the broker + UI are
provider-agnostic. **New HARD RULE §6.9 "Coordinates, not targets — the simulators
do not exist":** to the app + tests there is no sim-vs-real branch anywhere; only
**coordinates** (endpoints, credentials, resource ids) point at a target, and the
same code/test hits a sockerless sim or the real cloud by changing coordinates
alone, through standard APIs only (never a sim's `/internal`). The App e2e
(`github-app.e2e.ts`) is **purely coordinate-driven**: it reads the App's id + key +
org/repo + base URL from env and **skips** when absent — it has no notion of
bleephub. bleephub can't yet seed a pre-registered App via standard config, so CI
can't supply sim App coordinates; filed upstream as **sockerless#559** (the e2e runs
against real GitHub when secrets are supplied; the provider + app-JWT logic is
unit-tested meanwhile — 12 tests). Gates green (lint/knip/jscpd/build/unit).

**Prior phase (merged):** the **cost visualization** track (PR #71) —
the last of "admins + costs + audit" (admins ✓, audit ✓ #70). An admin **Costs**
console (`/admin/costs` + `/api/admin/costs`) prices each workspace's running vs.
scaled-to-zero time and rolls it up per session, per user, and to a fleet total
(compute = Fargate vCPU+memory while running; storage = live EBS while running;
snapshot = EBS snapshot while scaled-to-zero). Run-time is **derived from the
lifecycle audit ledger** (user decision), and pricing defaults to **us-east-1
on-demand, env-overridable** (`@edd/config`). Making the ledger authoritative
required **centralizing lifecycle audit in `WorkspaceService`**: it now records
`session.create/start/stop/delete` on the _actual_ state transition — so
gate-wakes (`connect()`) and reconciler scale-to-zero/drift stops are captured
exactly once (route-level emits removed; actor threaded, `system` for
machine/reconciler). **Accuracy is not an MVP compromise:** each event is written
in the SAME DynamoDB transaction as its transition (`createWriteTransaction`), so
the ledger can never drop or double-count a billable event — proven by
`cost-ledger-atomicity.integ.ts`; deleted workspaces still price (events are
append-only). **Live:** a running workspace's open interval is priced to `now` on
every fetch, and the page auto-refreshes (`LiveRefresh`, 15 s) so consumption is
visible in near real time. The pure cost model is in `@edd/core`
(`deriveBillingIntervals`/`priceIntervals`/`computeFleetCost`); `CostService`
joins the ledger with current records. Gates green (lint/knip/jscpd/unit/integ/
web build/Playwright 9/9).

**Prior (merged to `main`):** PR #68 (per-workspace proxy authz — gate PEP +
PDP), PR #69 (core user loop — repo-per-session + private clone/push broker +
wake-on-connect gate + GitHub launcher UI; polyglot golden image + real-VS-Code
proof + ECS hardening), PR #70 (first-class audit log). The core-user-loop detail
below describes the now-merged #69 work:

- **Repo-per-session** (incr. 1): `repoUrl` threaded end-to-end; golden image
  clones the repo on first boot (idempotent; skips on snapshot wake). Public
  clone proven against the real image. `repoUrl` optional (blank sessions OK).
- **Private clone + push** (incr. 1b): AES-256-GCM `token-crypto`, per-owner
  `gitCredential` entity + `GitCredentialService`; GitHub token captured at
  sign-in (encrypted, server-side); **agent-only broker**
  `GET /api/workspaces/:id/git-credential` + an in-image git credential helper
  fetch the token at use time — clone+push work with **nothing on the EBS
  volume**. Token never in task metadata or the browser.
- **Wake-on-connect gate** (incr. 2 core): the workspace gate resolves each
  workspace's live address per request (ws-id from Host → `POST /connect` wake →
  `GET /connect-info?protocol=http` via gateway HMAC) and proxies HTTP+WS — one
  gate fronts every workspace (Pomerium's single static upstream), waking
  scaled-to-zero sessions on reconnect (the "reopen → session intact" behavior;
  session state persists on the EBS snapshot). OpenVSCode
  `--without-connection-token` flag for the gated deployment.
- **GitHub session launcher** (incr. 3): `GitProvider` (list repos, namespaces
  with permission flags, create repo) + `/api/github/repos|namespaces` routes
  (token server-side only) + the **`/sessions/new` UI** — search repos → start
  session, or create a repo (default private; **grayed out with the reason** when
  not permitted), or blank session.

Decisions honored: clone via the user's GitHub OAuth token (encrypted, brokered);
gate-is-the-auth (tokenless OpenVSCode behind it); many sessions per repo per
user; cross-user isolation via proxy authz. Remaining: increment-2 deployment
wiring (Pomerium→gate route + full browser e2e) and the first-class audit log +
cost-visualization tracks. SAST hardening this round: pinned GCM auth tag length;
test secrets generated at runtime.

## Prior phase

**PRs #56–#67 are merged to `main`** (test-gap closure, gateway machine-auth,
sockerless #549/#550 consumption, live portal + Pomerium browser e2e over TLS,
the lifecycle correctness-hardening pass, the authz/concurrency depth pass —
delete-vs-wake leak fix, exhaustive CASL matrices, snapshot-vs-stop conflict fix
— and data durability across a real scale-to-zero cycle + the reconciler
container drift sweep).

**PR #68 is merged** (per-workspace proxy authorization — the gate PEP +
`/api/internal/authz` PDP, ownership by owner email).

Current branch `feat/vscode-workspace-proof` proves the headline product — a
usable VS Code workspace — and hardens the ECS service:

- **Polyglot golden image, out of the box.** `infra/images/workspace` now ships
  Node 22 (npm/yarn/pnpm/bun), C/C++ (build-essential), Go, Java + Maven +
  Gradle, Rust, Python + uv, and Playwright + headless Chromium. Tools install
  system-wide with a `/etc/profile.d` entry so they're on PATH for the OpenVSCode
  terminal and SSH. ~3 GB image (headless-shell, not full Chromium, to stay
  lean). `packages/e2e/src/workspace-toolchain.e2e.ts` compiles+runs a
  hello-world in every language (real artifacts) as the `workspace` user.
- **Real VS Code, driven in a browser.** `apps/web/e2e/vscode-workspace.pwvscode.ts`
  (`test:pw:vscode`) loads the OpenVSCode workbench, opens the integrated
  terminal, types code, compiles it, and verifies the produced ELF binary on
  disk — with screenshots. The headline promise, proven end to end.
- **OpenVSCode :3000 inside the sim ECS task.** `golden-workspace-ssh.e2e.ts`
  now also asserts the awsvpc task serves OpenVSCode on :3000 (its token gate),
  not just sshd.
- **ECS compute hardening** (gap audit): task def declares `portMappings`
  (3000 + 22); `executionRoleArn`/`taskRoleArn` supported; `fromEnv` reads task
  sizing + roles (were hardcoded in production); `awslogs-region` via config;
  `stopTask` sends a reason. Remaining follow-ups in `BUGS.md` → Open (readiness
  gating, ECS secrets, real `health()`).

Earlier on this line:

- **The gap:** the Pomerium wildcard route was `allow_any_authenticated_user`, so
  the proxy enforced no per-workspace ownership.
- **The fix (external-authz → control plane):** a workspace **gate**
  (PEP, `services/workspace-gate`) fronts each workspace, verifies the Pomerium
  identity assertion against Pomerium's JWKS, and calls a control-plane **PDP**
  (`/api/internal/authz`) that maps `<ws-id>` subdomain → owner in DynamoDB and
  allows only the owner (by **email** — the identity the Auth.js portal IdP and
  the Pomerium proxy IdP share; `sub`/`oid` differ) or an admin. Workspaces now
  record `ownerEmail`. Pomerium binds the assertion `aud` to the workspace host
  (verified in v0.32.2 source: `authorize/evaluator/headers_evaluator_evaluation.go`),
  so a token can't be replayed across workspaces.
- **Proof:** core unit tests (host→id parse, access decision), the gate component
  test (HTTP + WebSocket, allow/deny/missing/PDP-down), the PDP integration test
  (DynamoDB ownership, admin bypass, replay/expiry/forgery), and an end-to-end
  test that verifies a REAL Pomerium assertion against Pomerium's real JWKS
  (`apps/web/app/api/internal/authz/route.e2e.ts`). The harness `pomerium.yaml`
  keeps the direct identity-gate route for the identity-layer suites; production
  routes the workspace `to:` through the gate (documented inline).
- No sockerless bugs found (Pomerium assertion + JWKS verified faithfully).

Current branch `feat/data-durability-container-drift` adds the two end-to-end
gaps from the latest review (no new product bugs found):

- **Data durability across a real scale-to-zero cycle** — through
  `WorkspaceService`: SSH writes a marker+checksum into the workspace, `stop()`
  snapshots, `connect()` wakes a NEW task from the snapshot, and SSH into the
  woken task confirms the file is byte-identical. Proves "your work survives
  scale-to-zero" end to end (the prior data-fidelity test only covered the EBS
  primitives via bare tasks). `packages/e2e/src/data-durability.e2e.ts`.
- **Reconciler CONTAINER drift sweep** — `reconciler-container.e2e.ts` now also
  seeds a workspace whose task is killed out-of-band; the scheduler-fired
  reconciler container's `runMaintenance` drift pass reconciles it to stopped
  (the in-process drift path was already covered by `drift-recovery.e2e.ts`).

A follow-up depth pass (PR #66, `feat/authz-matrix-concurrency-gc`) hardened the
remaining unhappy paths and found one more real bug:

- **delete-vs-wake task leak (real bug, fixed):** `remove()` used an
  unconditional `.delete()`, so a delete racing a wake could remove the record
  while `start()` launched a task — orphaning it. `remove()` is now
  version-conditioned (claim-the-delete-first) and defers snapshot reaping to GC
  (the single storage reaper, with a grace window), which also removes a
  snapshot-vs-wake race. Proven by `concurrency-pairs.integ.ts`.
- **CASL matrices:** the unit ability table is now exhaustive (every
  role × action × subject, 62 cases); a route-level matrix asserts each HTTP
  route enforces it (viewer denied across every verb, member can't mutate the
  catalog, unauth → 401).
- **Concurrency pairs:** stop-vs-snapshot, stop-vs-heartbeat, two-snapshots, and
  delete-vs-wake each prove exactly one winner + one clean conflict (no 500, no
  double side effect) under the version guard.
- **GC TOCTOU:** a freshly-created unreferenced volume within the grace window
  is never reaped (protects a create racing the sweep).
- **ssh-cert hardening:** the public-key contract now rejects malformed/oversized
  /multi-line/unknown-type keys with 400 at the boundary (was a 500 from
  `ssh-keygen`); no shell injection (key written to a file).

Current branch: `feat/hardening-races-drift-scale` (PR #65) — the unhappy-path
hardening pass (the failure modes the happy-path coverage didn't reach), each
found or fixed via a test:

- **Concurrent-wake task leak (real bug, fixed):** `WorkspaceService.persist`
  was an unconditional PutItem, so two simultaneous `connect`/`start` calls on
  a stopped workspace both launched a real ECS task and the loser's leaked
  forever. Added an optimistic-concurrency `version` field; every transition is
  a conditional update (`persistTransition`), the wake loser stops its own
  just-launched task and returns the winner's state (idempotent). E2e fires 5
  concurrent connects and asserts exactly one task survives.
- **Crash-consistency (fixed):** `create`/`start` launch the task before
  persisting; a persist failure now stops the just-launched task instead of
  orphaning it. Integ injects a DynamoDB write outage via the AWS SDK
  middleware stack.
- **Drift detection (new feature):** the reconciler now runs a drift sweep
  FIRST — a record whose task died out-of-band (crash/eviction) is reconciled
  via the new `ComputeProvider.taskState()` to `stopped` (snapshot → wake-able)
  or `error` (nothing to restore), so connect-info never hands out a dead ENI
  and the idle sweep never snapshots a released volume. E2e kills a task with
  raw ECS StopTask and asserts recovery.
- **Pagination / quota-bypass (real bug, fixed):** `WorkspaceService.list`
  used a single-page `.go()`; past DynamoDB's 1 MB page it truncated, which
  undercounted the per-owner quota check (a **quota bypass at scale**) and hid
  workspaces from the admin list. Now `pages: "all"`; integ seeds >1 MB and a
  reconciler integ sweeps a 450-record fleet.
- **Adversarial auth tests:** forged/tampered Pomerium session cookie stays
  gated; Auth.js callback rejects a missing-PKCE-verifier replay and a reused
  authorization code (PKCE is the GitHub provider's active check, verified in
  `@auth/core`); sshd rejects a wrong-CA and an expired certificate.
- **Heavy data fidelity:** 64 MiB random payload round-trips snapshot→restore
  byte-for-byte (`sha256sum -c`). **TLS storage adapter:** the EBS adapter runs
  over the TLS aws-sim with real CA trust in `e2e-https`.

Security review (`/security-review`) on the branch diff: no HIGH/MEDIUM
findings; the pagination fix is itself a quota-bypass remediation.

Upstream: sockerless **PR #550** (bleephub Actions follow-ups — cancellation,
runner groups, composite actions, runner-on-cloud volume translation) merged
and the submodule pin bumped to `9d43f3d`; none of it touches our surfaces
(we consume bleephub for OAuth only), and the bleephub auth e2e pass on it.

## What works (built, tested, merged to `main`)

- **Monorepo** (`@edd/*`, Turborepo+pnpm); `main` protected.
- **Core** (`@edd/core`): branded domain types, lifecycle state machine, pure functions
  (provision/stop/start/snapshot/`markActivity`/`planConnect`, base-image catalog),
  Storage/Compute ports + fakes.
- **Control plane** (`apps/web` + `@edd/control-plane`): `WorkspaceService` lifecycle
  (create/stop/start/connect/heartbeat/snapshot/remove) + `CatalogService`, over
  ElectroDB, CASL-gated API + `@edd/api-client`. Fargate managed-EBS model.
- **Auth** (`@edd/auth`): GitHub + Entra → group→role, both proven mock-free & swappable.
- **Portal** (`apps/web`): RBAC workspaces grid + lifecycle, base-image catalog admin
  page + create-from-catalog picker.
- **Reconciler**: idle scale-to-zero, scheduled snapshots, orphan GC (pure selectors).
  Container (`services/reconciler`): esbuild bundle; scheduler→ECS→container e2e proven.
- **Real adapters** (endpoint-only): `@edd/storage-ec2`, `@edd/compute-ecs`.
- **Deploy IaC** (`infra/terraform/modules/ecs-dev-desktop`): reusable parametric module
  (VPC + NAT [managed or fck-nat], KMS, DynamoDB+GSIs, ECR, ECS + Fargate + autoscaling,
  ALB + optional ACM/Route53, scheduler, IAM, logs). **`terraform-sim` CI job applies +
  destroys the full stack every PR** in the default, fck-nat, and DNS/TLS configs
  (resource/functional assertions + idempotency). Endpoint-only (§6.8). Real apply is AWS-gated.
- **Golden workspace image** (`infra/images/workspace/`): Node 20 + OpenVSCode Server
  v1.109.5, tini PID-1, OpenSSH `sshd` with trusted CA/principal enforcement,
  idle-agent (heartbeats every 120s, HMAC machine-auth), and multi-arch
  OpenVSCode asset selection.
- **Real adapter wiring** (`apps/web/lib/control-plane.ts`): `COMPUTE_PROVIDER=ecs`,
  `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`; fakes remain default.
- **SSH gateway** (`services/ssh-gateway`): standard `sshd` + ephemeral CA
  (`scripts/gen-ssh-ca.sh`); `TrustedUserCAKeys` + `AuthorizedPrincipalsFile` RBAC;
  connect-as-principal + authz-deny proven mock-free. PTY allocation tested (`-tt`).
- **SSH cert API** (`POST /api/workspaces/:id/ssh-cert`): control plane signs user's
  public key with `ssh-keygen -s`; returns short-lived cert for `dev-<workspaceId>` principal.
- **Wake-on-connect proxy**: `sshHost` (ENI private IP — routable since sockerless PR #518;
  overlapping-CIDR VPC fidelity improved by PR #519)
  stored on `Workspace`/DB; `GET /api/workspaces/:id/connect-info` returns `{host, port}`;
  `Dockerfile.proxy` + `wake-and-forward.sh` + `proxy-entrypoint.sh` ForceCommand gateway
  authenticating with per-workspace HMAC machine-auth (`EDD_GATEWAY_SECRET`).
  Full chain e2e: client SSH → proxy container → REAL control plane (wake from
  stopped) → nc → workspace node; the stub-CP variant remains as a component test.
- **Workspace CloudWatch log shipping**: `EcsComputeProvider` adds `awslogs` `logConfiguration`
  to every task definition; `ECS_LOG_GROUP_WORKSPACES` injected by Terraform.
- **In-app editor proxy** (`apps/web/server.ts` + `apps/web/lib/workspace-proxy.ts`): the custom
  Next.js server proxies the per-user editor at the path-based `app.<domain>/w/<id>/` (HTTP + WS
  upgrade), authorized in-process by the Auth.js session (uid-ownership/admin) — single domain, no
  wildcard DNS/TLS. The vscode browser e2e drives the editor under the `/w/<id>/` base path.
  (Pomerium + the standalone `workspace-gate` were removed 2026-06-20.)
- **Phase 8 (8A+8B+8C)**: admin console (health board, all-workspaces, Inspect, Overview,
  quotas, Logs/Audit); `@edd/cloudtrail-audit` + `@edd/cloudwatch-logs` endpoint-only
  adapters, integration-tested against the sim.
- **Test tiers**: unit/contract · integration (DynamoDB Local + process sim;
  route-level lifecycle/gateway-auth/admin-data suites) · e2e (data-fidelity,
  LIVE user journey through the real API on container-mode adapters, lifecycle,
  auth incl. Auth.js callback routes, the in-app path-based editor proxy, OpenSSH gateway + real-CP wake
  chain, overlapping-CIDR awsvpc, reconciler container incl. real scale-to-zero,
  managed-EBS golden workspace SSH, ECS Exec smoke) · live admin observability
  route tests against sockerless AWS CloudTrail/CloudWatch · portal e2e
  (Playwright) · `e2e-https` (sims over TLS, real CA trust, no `--insecure`;
  incl. the Entra Auth.js callback leg) · manual `e2e-aws`.
- **Engineering quality**: typed `Result<T, DomainError>` channel; compile-time
  exhaustiveness guards; typed `data-testid` registry; `waitForDynamo` harness
  determinism; `knip` + `jscpd` code-health gates; SAST + Trivy.

## Deployed

**Live on real AWS** — see the top-of-file section for current detail (superseding this
stale "nothing deployed" note from before the first real `apply`).

## Immediate focus

See `DO_NEXT.md` — the AWS account/region and domain decisions (formerly #1/#2 here)
are resolved and live; current priorities are the still-queued UI/UX requests
(session-creation flow redesign with a live status/logs page, an "open terminal with
`<keybinding>`" OpenVSCode title-bar element, whitelisted extension installs) and
confirming the in-flight golden-image rebuild once it lands.
