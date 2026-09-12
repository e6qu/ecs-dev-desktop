#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editor manager: owns the editor's public port and the editor's lifetime.
//
// The editor used to be PID 1 (`exec openvscode-server`), which made two things
// impossible at once. The container died if the editor died, and the editor could
// never be stopped on purpose — so every workspace paid for a running IDE server
// whether or not a browser was ever pointed at it. On a box sized for many
// concurrent agent sessions that is the single largest per-session cost, and it
// buys nothing for a session driven entirely through the Claude or Codex CLI.
//
// So this process is PID 1 instead. It listens on the public port, starts the
// editor on first connection, and stops it again once nothing has used it for
// EDD_EDITOR_IDLE_MS. The container's life is now independent of the editor's.
//
// Three ports, because the health probe must not be the thing that keeps waking
// the editor:
//
//   PUBLIC (3000)  this process. Any connection activates the editor and is then
//                  piped to it, byte for byte — a TCP pipe rather than an HTTP
//                  proxy so the editor's WebSocket upgrade needs no special case.
//   EDITOR (3001)  the real editor, bound to loopback, started and stopped here.
//   STATUS (3002)  this process's own health/state, answered without activating
//                  anything. idle-agent probes this.
//
// Agent CLI sessions do not run under the editor: the workspace's terminal
// profile attaches to a tmux server this process starts, so `claude` and `codex`
// keep running across an editor stop, an editor crash, and a browser that went
// away. That is the whole point of unloading the editor rather than the task.

import { createServer as createTcpServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.EDD_EDITOR_PUBLIC_PORT ?? 3000);
const EDITOR_PORT = Number(process.env.EDD_EDITOR_INTERNAL_PORT ?? 3001);
const STATUS_PORT = Number(process.env.EDD_EDITOR_STATUS_PORT ?? 3002);
// 15 minutes: the window the product already uses for "not actively used".
const IDLE_MS = Number(process.env.EDD_EDITOR_IDLE_MS ?? 15 * 60 * 1000);
const START_TIMEOUT_MS = Number(process.env.EDD_EDITOR_START_TIMEOUT_MS ?? 60_000);

const editorArgv = process.argv.slice(2);
if (editorArgv.length === 0) {
  console.error("edd-editor-manager: give the editor command after --");
  process.exit(64);
}

/** @type {import("node:child_process").ChildProcess | null} */
let editor = null;
let startingFor = null; // Promise while a start is in flight, so N simultaneous
// connections produce one editor rather than N.
let live = 0; // open proxied connections
let lastUsed = Date.now();
let stops = 0;
let starts = 0;

const log = (msg) => console.log(`[edd-editor-manager] ${msg}`);

function editorRunning() {
  return editor !== null && editor.exitCode === null && editor.signalCode === null;
}

/** Resolves once something is accepting on the editor port, or rejects on timeout. */
function waitForEditorPort(deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const probe = connect({ port: EDITOR_PORT, host: "127.0.0.1" });
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", () => {
        probe.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`editor did not listen on ${EDITOR_PORT} in time`));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function startEditor() {
  if (editorRunning()) return Promise.resolve();
  if (startingFor !== null) return startingFor;

  starts += 1;
  log(`starting the editor (start #${starts})`);
  const child = spawn(editorArgv[0], editorArgv.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  editor = child;
  child.on("exit", (code, signal) => {
    log(`editor exited (code=${code} signal=${signal})`);
    if (editor === child) editor = null;
  });

  startingFor = waitForEditorPort(Date.now() + START_TIMEOUT_MS)
    .then(() => {
      log("editor is accepting connections");
    })
    .catch((err) => {
      log(`editor failed to start: ${err.message}`);
      // Leave it running if it is alive but slow; the next connection retries.
      throw err;
    })
    .finally(() => {
      startingFor = null;
    });
  return startingFor;
}

function stopEditor(why) {
  if (!editorRunning()) return;
  stops += 1;
  log(`stopping the editor after ${why} (stop #${stops})`);
  editor.kill("SIGTERM");
}

// The idle sweep never looks at CPU. A busy `claude` session is exactly the case
// this feature exists for: the agent should keep the workspace alive (the
// reconciler's own idle rules still see its PTY and load) while the editor, which
// nobody is looking at, goes away.
setInterval(() => {
  if (!editorRunning() || live > 0) return;
  if (Date.now() - lastUsed >= IDLE_MS) {
    stopEditor(`${Math.round(IDLE_MS / 60000)}m without a connection`);
  }
}, 30_000).unref?.();

const proxy = createTcpServer((client) => {
  lastUsed = Date.now();
  live += 1;
  client.on("close", () => {
    live -= 1;
    lastUsed = Date.now();
  });
  client.on("error", () => client.destroy());

  startEditor()
    .then(() => {
      const upstream = connect({ port: EDITOR_PORT, host: "127.0.0.1" });
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    })
    .catch(() => client.destroy());
});

proxy.listen(PUBLIC_PORT, "0.0.0.0", () => {
  log(`listening on ${PUBLIC_PORT}; editor starts on demand, idles out after ${Math.round(IDLE_MS / 60000)}m`);
});

// Status, answered without touching the editor, so probing is free and does not
// defeat the idle timer.
createHttpServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      manager: "up",
      editor: editorRunning() ? "running" : "stopped",
      liveConnections: live,
      idleMs: IDLE_MS,
      msSinceLastUse: Date.now() - lastUsed,
      starts,
      stops,
    }),
  );
}).listen(STATUS_PORT, "127.0.0.1", () => {
  log(`status on 127.0.0.1:${STATUS_PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    stopEditor(sig);
    proxy.close();
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
