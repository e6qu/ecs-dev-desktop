<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Workspace Agent Harnesses

EDD did not reimplement agent chat UIs. Workspace interface choices either ran
a real editor we owned (`monaco`) or reused a verified vendor-provided local
browser surface. When a vendor only exposed a protocol server or hosted/cloud
web product, EDD did not pretend that was a local web UI.

## Current Modes

- `openvscode`: OpenVSCode Server under `/w/<workspace-id>/`.
- `monaco`: EDD's first-party lightweight Monaco editor under `/w/<workspace-id>/`.
- `terminal`: EDD's first-party multi-tab terminal under `/w/<workspace-id>/`.
  The workspace image ships both `claude` and `codex` CLIs on PATH. Users run
  the vendor CLIs directly in the terminal; EDD does not expose separate Claude
  or Codex workspace types.
- `opencode`: opencode's own `opencode web` process, authenticated with
  `OPENCODE_SERVER_USERNAME=opencode` and `OPENCODE_SERVER_PASSWORD` set to the
  workspace connection token. The EDD proxy injected Basic auth after the normal
  Auth.js owner/admin authorization.

## Verified Vendor Facts

- Claude Code 2.1.202 local verification found `claude`, `claude agents`,
  `claude daemon`, `claude remote-control`, `claude gateway`, and hosted
  `--cloud`/`--teleport` flows in the CLI reference. `claude web --help` and
  `claude serve --help` did not expose local web commands; they returned the
  top-level help. `claude agents --json --all` returned JSON and
  `claude daemon status` reported the background supervisor state. The installed
  `~/.local/share/claude/versions/2.1.202` tree contained only native version
  binaries, not a separate static web-app bundle. Official docs described
  `claude agents` as an interactive terminal agent view and `claude.ai/code` as
  hosted/cloud Claude Code on the web, not an EDD-hostable local website.
- Claude Remote Control was a real Anthropic-hosted control surface, but not a
  local EDD-hosted web UI. Official docs described it as `claude.ai/code` or the
  Claude mobile app driving a Claude Code process that stayed running locally;
  the local process made outbound HTTPS requests only and did not open inbound
  ports. It required a claude.ai subscription/login and, for Team/Enterprise,
  server-side organization enablement. Local testing on this workstation could
  not start or print Remote Control flags because `claude remote-control --help`
  failed first with "You must be logged in to use Remote Control" and
  `claude auth status --text` reported not logged in. EDD could integrate Remote
  Control only as an explicit "start local Claude process and show the vendor
  `claude.ai/code` session URL" flow, not as `/w/<workspace-id>/` content.
- Codex 0.144.0 local verification found `codex app-server` with stdio,
  Unix-socket, and WebSocket transports. Official OpenAI source described it as
  the interface that powers rich clients such as the Codex VS Code extension and
  documented only JSON-RPC transports plus HTTP `/readyz` and `/healthz`. Running
  `codex app-server --listen ws://127.0.0.1:45679` printed only the WebSocket
  endpoint and health probes. A browser screenshot of `http://127.0.0.1:45679/`
  showed `Connection header did not include 'upgrade'`, confirming the app-server
  root was a WebSocket upgrade endpoint, not a browser UI. The standalone local
  Codex install contained only `bin/codex`, `bin/codex-code-mode-host`, bundled
  `rg`, and zsh resources; no local static web client bundle was found.
- Codex Remote Control was also a distinct first-party command, but official
  docs described it as managing the local app-server daemon with remote control
  enabled and creating a short-lived manual pairing code. The docs explicitly
  said it was not a replacement for `codex app-server --listen` when building a
  local protocol client. Local CLI help confirmed `codex remote-control start`,
  `stop`, and `pair`, but this remained a remote/pairing flow, not an EDD-hosted
  browser UI.
- opencode exposed a local browser UI with `opencode web`. Local verification of
  `opencode 1.17.13` showed `--hostname`, `--port`, `--mdns`, `--mdns-domain`,
  `--cors`, and `--print-logs`, but no base-path flag. Official opencode docs
  and source confirmed `opencode web` starts a local server and opens a browser
  UI, and `OPENCODE_SERVER_PASSWORD` protects network access. Local Playwright
  verification started `BROWSER=false OPENCODE_SERVER_PASSWORD=edd-local-test
opencode web --hostname 127.0.0.1 --port 45678 --print-logs` and captured
  `/private/tmp/opencode-local-web.png`, which rendered the opencode browser UI.

Community/news searches on Reddit, Hacker News, and YouTube-oriented queries did
not establish a Claude or Codex standalone local web UI command. The results
mostly referred to hosted Claude Code on the web, the ChatGPT/Codex desktop or
hosted web surfaces, or generic agent usage. Those are not accepted EDD
substitutes.

## Proxy Contract

OpenVSCode and Monaco were base-path-aware in EDD and received requests with
`/w/<workspace-id>/` preserved. Terminal uses the same first-party server as
Monaco with the file editor hidden and the multi-tab terminal promoted to the
workspace surface. Claude and Codex must not be routed through OpenVSCode or
Monaco as separate workspace types.

opencode was not base-path-aware. For `editor=opencode` only, the in-app
workspace proxy:

- authorized the browser with the normal Auth.js session and owner/admin check;
- derived the same per-workspace connection token compute injected;
- injected `Authorization: Basic <opencode:token>` upstream;
- stripped `/w/<workspace-id>` before forwarding to opencode;
- rewrote opencode HTML/JS/CSS references needed for the root-mounted web client
  to load under EDD's path-based proxy.

This was intentionally not a fallback. If `EDD_CONNECTION_SECRET` was absent, if
the request was outside the workspace prefix, or if the image lacked the
opencode CLI, opencode workspaces failed loudly.
