<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Design proposal: read-only workspace view ("spectate")

> Status: **PROPOSAL — partially signed off** (2026-07-06). User decisions
> received: spectators must be **authenticated EDD users with at least the
> `viewer` role** (no anonymous/public links), and spectator count is
> **unbounded** (no artificial cap). Remaining open decisions at the bottom.

## Requirement (user, 2026-07-06, refined)

A workspace owner can allow **view access** to their workspace — spectators see
the live session including **mouse position, focus, and keystrokes** — via a
**toggle widget on the workspace card**, **default disabled**. Spectators must
be **signed-in EDD users with at least the `viewer` role**; any number of
spectators may watch concurrently.

## Threat model — why this needs care

This is the largest new attack surface added since launch (materially reduced
by the authenticated-viewer decision, but still real):

- Sharing exposes live workspace content to every org member with a `viewer`+
  session: source code, terminal scrollback (which routinely contains secrets:
  env vars, tokens pasted by the user, `claude` output), and every keystroke —
  including passwords/tokens the owner types while sharing is on. The
  confirmation dialog must spell this out.
- The existing proxy authz (`authorizeWorkspace`) is the wall between the
  internet and workspace containers. Any public path must be a **separate,
  strictly read-only channel** — never a weakening of that wall.
- OpenVSCode Server has **no native read-only/spectator mode**: its protocol
  assumes an authorized client that can execute commands, open terminals, and
  edit. Granting a spectator ANY OpenVSCode socket = granting write access.
  A "read-only OpenVSCode spectator" would mean re-implementing protocol-level
  filtering of a complex, unversioned-for-us wire protocol — rejected as
  unauditable.

## Proposed design (Monaco-first, mirror-stream architecture)

**Spectators never connect to the workspace.** They connect to a broadcast of
what the owner's editor session shows.

1. **Share flag on the workspace record**: `share?: { enabled: boolean;
enabledAt }`. No share token needed — access is gated on the Auth.js
   session + CASL `viewer`-or-above role + the flag, exactly like every other
   authorized route (revocation = toggle off, instant). Toggling writes an
   audit event (`session.share_enabled/disabled`).
2. **Owner-side capture**: in the Monaco editor SPA (and, best-effort, a
   `edd-workspace-ui` extension contribution for OpenVSCode later), the OWNER's
   browser mirrors its own view state — open file + viewport, cursor/selection,
   mouse position, terminal output frames, focus — over a `spectate-publish`
   WebSocket to the control plane (session-authorized, same as any owner
   request).
3. **Spectator side**: `GET /workspaces/<id>/spectate` — session-authorized
   (signed-in, `viewer`+ role, share flag enabled), then a read-only
   `spectate-subscribe` WebSocket fed ONLY by the owner's publish stream.
   Spectators receive rendered state; there is **no request path from
   spectator to workspace** — read-only by construction, not by filtering.
4. **Keystrokes**: what the owner types appears via the mirrored terminal
   output/editor deltas (the requirement's intent) — spectators never see raw
   input events beyond what the mirror renders.
5. **Lifecycle**: sharing auto-disables on workspace stop/delete and on owner
   session expiry (the publish socket dies; subscribers see "sharing ended").
   Spectator connections count toward NOTHING (not presence/idle — a public
   viewer must not keep a workspace billing).
6. **Card widget**: default-off toggle → confirmation dialog spelling out
   exactly what becomes visible (and to whom: all signed-in viewers) → the
   spectate URL with a copy button + "stop sharing".

## Costs / limitations

- Real implementation effort: publish/subscribe relay in the control plane,
  SPA capture code, new public route — a full feature, not a patch.
- OpenVSCode sessions can't be mirrored this way without extension work that
  captures its DOM/state; **v1 would be Monaco (and the claude/codex
  agent-terminal modes, which are Monaco-served) only.**
- The relay adds per-spectator fan-out load on the control plane. Per user
  decision spectator count is UNBOUNDED — fan-out is a same-replica broadcast
  of small state deltas, so hundreds of viewers are cheap; if a workspace ever
  draws thousands, the relay shards behind the existing control-plane
  autoscaling (each replica serves the subscribers it terminates, subscribing
  replicas relay from the one holding the publisher).

## Decisions

- **DECIDED (user, 2026-07-06)**: spectators are authenticated EDD users with
  at least the `viewer` role — no anonymous/public links, no share tokens.
- **DECIDED (user, 2026-07-06)**: no cap on concurrent spectators.

## Still open (need the user)

1. **Scope OK?** v1 = Monaco + agent-terminal modes only (OpenVSCode later,
   via extension-based capture)?
2. **Terminal scrollback**: mirror from share-enable moment only (proposed —
   no history backfill), or include existing scrollback?
3. **Retention**: no recording, live-only (proposed)?

## Alternatives considered

- **Read-only proxy filtering of OpenVSCode's protocol** — rejected
  (unauditable write-blocking of a complex third-party protocol).
- **VNC/screen-streaming sidecar** — rejected for v1 (heavy image transport,
  new container dependency, worse latency than state mirroring).
- **tmate/upterm-style terminal-only sharing** — viable subset, but doesn't
  show editor/mouse/focus; the mirror design supersedes it.
