#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent-session registry: what sessions this workspace has, and what became
// of them.
//
// tmux keeps a session alive across an editor stop, an editor crash and a closed
// browser, but its state lives in /tmp and dies with the container. A workspace
// that scales to zero — which is the whole point of scale-to-zero — would lose
// every record that the session ever existed, and the user would come back to an
// empty screen with no way to tell whether their agent had finished, crashed, or
// never run.
//
// So the record lives on the volume. `HOME` is /data/home on the EBS-backed
// volume, so the agents' own transcripts already survive a stop/start; this adds
// the index over them: which sessions existed, in which directory, running what,
// and when they were last seen alive.
//
//   record <name> <cwd> <command...>   upsert an entry, mark it running
//   sweep                              reconcile against live tmux; mark what died
//   restore                            recreate registered sessions that are not live
//   list [--json]                      report, for the heartbeat and the CLI
//
// `restore` deliberately does NOT run the agent again. Re-running `claude` or
// `codex` unattended on every workspace boot is a side-effecting act the user did
// not ask for at that moment: it can edit files, open pull requests, or spend
// money. The session is recreated in its recorded directory with the resume
// command staged in the shell's history, one keypress away. EDD_SESSION_AUTORESUME=1
// opts into running it, per session, for people who want it.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME ?? "/data/home";
const REGISTRY = process.env.EDD_SESSION_REGISTRY ?? join(HOME, ".edd", "sessions");
const AUTORESUME = process.env.EDD_SESSION_AUTORESUME === "1";

const tmux = (...args) => spawnSync("tmux", args, { encoding: "utf8" });

/** Session names tmux currently holds. An absent server is not an error: it means
 * nothing is running yet, which is the normal state of a freshly booted task. */
export function liveSessions(run = tmux) {
  const out = run("list-sessions", "-F", "#{session_name}");
  if (out.status !== 0) return new Set();
  return new Set(
    String(out.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  );
}

/** The resume invocation for a recorded command, or null when the agent has no
 * documented resume. Kept as data rather than guessed at the call site. */
export function resumeCommandFor(command) {
  const program = command.trim().split(/\s+/)[0] ?? "";
  const base = program.split("/").pop() ?? program;
  if (base === "claude") return "claude --continue";
  if (base === "codex") return "codex resume --last";
  return null;
}

/** Wait until the session's pane is running a shell that can receive input.
 * send-keys delivered before the shell has drawn its prompt is silently dropped —
 * the staged resume command simply vanishes, and the user sees an empty terminal
 * with no hint that anything was meant to be there. Observed on the first run of
 * this code, so it is waited for rather than slept past. */
export function waitForShell(name, run = tmux, attempts = 40, sleepMs = 50) {
  const shells = new Set(["bash", "sh", "zsh", "dash", "fish"]);
  for (let i = 0; i < attempts; i += 1) {
    const out = run("list-panes", "-t", name, "-F", "#{pane_current_command}");
    if (out.status === 0) {
      const commands = String(out.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      if (commands.some((c) => shells.has(c))) return true;
    }
    // Busy-wait rather than async: this runs once at boot, before anything else
    // needs the event loop, and keeps the caller a plain sequential script.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  }
  return false;
}

function entryPath(name) {
  return join(REGISTRY, `${name.replace(/[^A-Za-z0-9_-]/g, "-")}.json`);
}

function readAll() {
  try {
    return readdirSync(REGISTRY)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(REGISTRY, f), "utf8"));
        } catch {
          return null; // A truncated file is not worth failing the boot over.
        }
      })
      .filter((e) => e !== null);
  } catch {
    return [];
  }
}

function write(entry) {
  mkdirSync(REGISTRY, { recursive: true });
  writeFileSync(entryPath(entry.name), JSON.stringify(entry, null, 2) + "\n");
}

function record(name, cwd, command) {
  const now = new Date().toISOString();
  const prior = readAll().find((e) => e.name === name);
  write({
    name,
    cwd,
    command,
    resumeCommand: resumeCommandFor(command),
    createdAt: prior?.createdAt ?? now,
    lastSeenAt: now,
    status: "running",
  });
}

/** Mark entries whose tmux session has gone. "stopped" rather than "crashed":
 * from here the two are indistinguishable, and claiming a crash the user did not
 * have is worse than saying less. */
function sweep() {
  const live = liveSessions();
  const now = new Date().toISOString();
  for (const entry of readAll()) {
    if (live.has(entry.name)) {
      write({ ...entry, lastSeenAt: now, status: "running" });
    } else if (entry.status === "running") {
      write({ ...entry, status: "stopped" });
    }
  }
}

function restore() {
  const live = liveSessions();
  for (const entry of readAll()) {
    if (live.has(entry.name)) continue;
    const resume = entry.resumeCommand;
    const created = tmux("new-session", "-d", "-s", entry.name, "-c", entry.cwd ?? HOME);
    if (created.status !== 0) {
      process.stderr.write(`edd-session: could not recreate ${entry.name}\n`);
      continue;
    }
    if (resume !== null && resume !== undefined) {
      if (!waitForShell(entry.name)) {
        process.stderr.write(`edd-session: ${entry.name} has no shell yet; not staging its resume\n`);
        write({ ...entry, status: "restored" });
        continue;
      }
      if (AUTORESUME) {
        tmux("send-keys", "-t", entry.name, resume, "Enter");
      } else {
        // Staged, not run: it lands in the shell's line editor so the user
        // presses Enter if and when they want it.
        tmux("send-keys", "-t", entry.name, resume);
      }
    }
    write({ ...entry, status: AUTORESUME ? "running" : "restored" });
  }
}

function list(asJson) {
  const live = liveSessions();
  const rows = readAll().map((e) => ({ ...e, live: live.has(e.name) }));
  if (asJson) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${r.live ? "live   " : r.status.padEnd(7)} ${r.name}  ${r.command}\n`);
  }
}

// Only dispatch when run as a program. Importing this file — which the unit tests
// do, to cover the decisions above without standing up a tmux server — must not
// execute a command or exit the process.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

const [cmd, ...rest] = invokedDirectly ? process.argv.slice(2) : ["__imported__"];
if (cmd === "__imported__") {
  // no-op: imported for its exports
} else
switch (cmd) {
  case "record":
    if (rest.length < 3) {
      process.stderr.write("usage: edd-session record <name> <cwd> <command...>\n");
      process.exit(64);
    }
    record(rest[0], rest[1], rest.slice(2).join(" "));
    break;
  case "sweep":
    sweep();
    break;
  case "restore":
    restore();
    break;
  case "list":
    list(rest.includes("--json"));
    break;
  default:
    process.stderr.write("usage: edd-session record|sweep|restore|list\n");
    process.exit(64);
}
