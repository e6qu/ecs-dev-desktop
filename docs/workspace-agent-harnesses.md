<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Workspace Agent Harnesses

EDD did not reimplement agent chat UIs. Workspace interface choices either ran
a real editor we owned (`monaco`) or reused a vendor-provided client surface.

## Current Modes

- `openvscode`: OpenVSCode Server under `/w/<workspace-id>/`.
- `monaco`: EDD's first-party lightweight Monaco editor under `/w/<workspace-id>/`.
- `claude`: OpenVSCode Server with the Anthropic Claude Code OpenVSCode
  extension auto-opened. The Claude Code CLI also had to be present. If either
  was missing, the workspace exited loudly.
- `codex`: OpenVSCode Server with the OpenAI Codex/OpenAI ChatGPT OpenVSCode
  extension auto-opened. The Codex CLI also had to be present. If either was
  missing, the workspace exited loudly.
- `opencode`: opencode's own `opencode web` process, authenticated with
  `OPENCODE_SERVER_USERNAME=opencode` and `OPENCODE_SERVER_PASSWORD` set to the
  workspace connection token. The EDD proxy injected Basic auth after the normal
  Auth.js owner/admin authorization.

## Verified Vendor Facts

- Claude Code on the web was a hosted Anthropic cloud product at
  `claude.ai/code`. It ran code on Anthropic-managed infrastructure. Claude
  Remote Control let `claude.ai/code` attach to a local Claude Code process, but
  local verification did not find an EDD-hostable standalone HTTP web UI command.
  EDD therefore used Anthropic's own OpenVSCode extension UI and opened its
  `claude-vscode.sidebar.open` command.
- Codex `app-server` was the local protocol server used by rich clients.
  Official OpenAI docs described stdio, Unix-socket, and experimental WebSocket
  transports, plus `/readyz` and `/healthz`. Exposing a non-loopback
  unauthenticated WebSocket was unsafe; EDD did not expose it directly. EDD used
  OpenAI's own OpenVSCode extension UI and opened its `chatgpt.openSidebar`
  command.
- opencode exposed a local browser UI with `opencode web`. Local verification of
  `opencode-ai@1.17.15` showed `--hostname`, `--port`, `--mdns`,
  `--mdns-domain`, `--cors`, and `--print-logs`, but no base-path flag. Its HTML
  and bundle used root-absolute assets and APIs.

## Proxy Contract

OpenVSCode, Claude, Codex, and Monaco were base-path-aware in EDD and received
requests with `/w/<workspace-id>/` preserved.

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
