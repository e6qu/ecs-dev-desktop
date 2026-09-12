<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Persistent agent sessions, and an editor that unloads

A workspace costs 0.5 vCPU and 2 GiB because it is a dev desktop: OpenVSCode
Server, `sshd`, the Monaco service, the idle-agent, and the omnibus toolchain
(3.05 GB compressed, 46 layers). That is the right shape for a human at an IDE.
It is the wrong shape for a session driven entirely through the Claude or Codex
CLI, which needs none of the editor and pays for all of it.

The cost is not hypothetical. On the Scaleway host the deployment runs on — 8
cores, 92 GB RAM — a third of the machine at that sizing is about five
concurrent workspaces, CPU-bound. Reaching hundreds of concurrent agent sessions
means not paying for an IDE nobody opened.

This document is the plan for that, and for what it forces: if the editor can be
stopped under a running session, the session must stop belonging to the editor.

## Why the editor could not be stopped before

`exec gosu workspace openvscode-server` made the editor PID 1. Two consequences,
and the second is the one that matters:

1. The container died when the editor died, so stopping the editor deliberately
   stopped the task.
2. Terminals were PTYs the editor spawned, so every `claude` and `codex` session
   was a child of the editor. Stopping the editor killed the work.

## The four pieces

### 1. The editor is socket-activated (done)

`edd-editor-manager` is PID 1. It owns the public port, starts the editor on the
first connection, and stops it once nothing has used it for
`EDD_EDITOR_IDLE_MS` (15 minutes by default).

| port | who |
|---|---|
| 3000 | the manager: accepts, activates, then pipes bytes |
| 3001 | the editor, on loopback, started and stopped on demand |
| 3002 | the manager's own status, answered without activating anything |

The third port is not tidiness. A health probe against the public port is
indistinguishable from a user opening the IDE, so probing there would wake the
editor on every beat and the idle timeout would never once fire. `idle-agent`
therefore probes 3002, which reports whether the editor is running or
deliberately stopped — so "unreachable" still means a fault rather than "nobody
has opened it yet".

This is the systemd/xinetd socket-activation pattern with one deliberate
difference. systemd holds the listening socket itself and passes the file
descriptor to the service on first connection (`$LISTEN_FDS`, starting at fd 3),
so the service never binds. There is no systemd in the task, and the editor does
not speak the protocol, so the manager keeps the socket and proxies to a
loopback port instead. The observable behaviour is the same; the cost is one
extra hop, which for an editor session is noise.

Neither systemd nor xinetd stops an idle service on its own — that logic always
belongs to the application. The manager does it, and deliberately does not look
at CPU when deciding: a busy `claude` is exactly the case where the editor
should still go away.

**ECS specifics that decide whether this is safe:**

- Workspace task definitions declare no container `healthCheck`. Verified — only
  the control plane has one, against its own `/api/healthz`. An ECS health check
  against the editor port would have woken it every 10 seconds.
- Workspaces are reached through the in-app proxy at `/w/<id>/`, not an ALB
  target group, so no load-balancer health check touches the editor port either.
  A future target group in front of a workspace must point at 3002, not 3000.
- `awsvpc` gives each task its own ENI, so these ports are per-task and there is
  no host-level collision to design around.
- ECS sends `SIGTERM` to PID 1 on stop. PID 1 is now the manager, which forwards
  a stop to the editor and exits — the task still terminates promptly.

### 2. Terminals attach to tmux rather than to the editor (done)

All three UI modes converge on one tmux server owned by the container:

- **OpenVSCode** — a seeded `terminal.integrated.profiles.linux` entry pointing
  at `edd-shell`.
- **Monaco and terminal-only** — the same path, because terminal-only is the
  Monaco server with a flag; the `node-pty` spawner runs
  `tmux new-session -A -s <name> -- $SHELL …`.

`new-session -A` attaches when the session exists and creates it otherwise,
which is the reconnect-or-start behaviour a reopened tab wants. Plain tabs share
`edd`; an agent-first tab gets `edd-<command>`, so `claude` and `codex` are
different sessions and reopening either rejoins the work in progress. The name
is slugged because tmux reads `.` and `:` as session address syntax.

This survives an editor stop, an editor crash, and a closed browser. It does not
survive the container stopping, which is the next piece.

### 3. Sessions survive the workspace stopping (planned)

tmux state is in `/tmp` and dies with the container. What already persists is
better than it looks: `HOME` is `/data/home` on the EBS-backed volume, so the
agents' own transcripts and config survive a stop/start — the material their
`--continue`/`--resume` needs is already there.

What is missing is the record of which sessions existed and what they were
doing:

- A registry under `/data/home/.edd/sessions/`, one file per session, holding
  the command, cwd, creation and last-seen time, and last known status.
- `edd-session` writes it when a session starts and updates it as tmux reports.
- On boot the entrypoint reconciles: registered sessions that are not live are
  recreated, in the recorded cwd, ready to resume.

**Open decision, and it should be made deliberately rather than by default:**
whether boot *runs* the agent's resume command or only stages it. Re-running an
agent unattended on every workspace start is a side-effecting act the user did
not ask for at that moment. The safer default is to recreate the session and
leave the resume command staged; auto-resume becomes opt-in per session.

### 4. The UI can see sessions while the workspace is down (planned)

A registry on the volume is invisible when the workspace is stopped, which is
exactly when a user most wants to know what is waiting for them. Session state
therefore has to reach the control plane.

The channel already exists: `idle-agent` POSTs
`/api/workspaces/:id/heartbeat` every two minutes with an activity self-report.
Extending that payload with the session list is the smallest change that puts
sessions in DynamoDB, where the UI already reads workspace state.

That means, in order:

1. `idle-agent` includes a `sessions` array in the heartbeat body.
2. The heartbeat route validates and persists it on the workspace record.
3. The workspace view lists sessions with their last known status, for a stopped
   workspace as readily as a running one.
4. Waking a workspace from a session in that list lands the user back in that
   tmux session.

Steps 1 and 2 are small. Step 3 is UI work. Step 4 needs the wake path to carry
a session hint.

## What is deliberately not claimed

The socket activation and the tmux inversion are verified: the manager starts
the editor on first connection, stops it after the idle window, and restarts it
on the next connection, and twenty simultaneous first-connections produce one
editor rather than twenty. That verification used a stand-in editor, not
OpenVSCode, and not inside a real task. Two consequences remain unmeasured:

- **The first load after an unload pays OpenVSCode's startup.** Seconds, not
  instant. Whether that is acceptable, or wants a keep-warm window longer than
  15 minutes, is a product judgement that should be made against a measurement.
- **The memory actually reclaimed is unmeasured.** 2 GiB is an allocation, not a
  reading. The number that matters is the resident set of an idle workspace with
  the editor stopped versus running, and it should be measured before any
  re-sizing is justified by it.
