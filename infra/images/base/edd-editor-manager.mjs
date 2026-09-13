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
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.EDD_EDITOR_PUBLIC_PORT ?? 3000);
const EDITOR_PORT = Number(process.env.EDD_EDITOR_INTERNAL_PORT ?? 3001);
const STATUS_PORT = Number(process.env.EDD_EDITOR_STATUS_PORT ?? 3002);
// 15 minutes: the window the product already uses for "not actively used".
const IDLE_MS = Number(process.env.EDD_EDITOR_IDLE_MS ?? 15 * 60 * 1000);
// A cold OpenVSCode start on a loaded CI runner is slower than a warm one on a
// developer's machine, and the cost of waiting too long is a slow first load
// while the cost of giving up too early is a failed connection. 120s favours the
// former.
const START_TIMEOUT_MS = Number(process.env.EDD_EDITOR_START_TIMEOUT_MS ?? 120_000);

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

/** Resolves once the editor is serving HTTP, or rejects on timeout.
 *
 * Accepting a TCP connection is NOT the same as being ready to answer. A cold
 * OpenVSCode binds its port early and finishes initialising afterwards, and a
 * request that arrives in that window is closed rather than served — the client
 * sees `other side closed` and a failed page load, which is exactly how this
 * first showed up in the live IDE e2e. So readiness is an actual HTTP exchange:
 * the editor has to produce a response line before a user's bytes are handed to
 * it. Any status counts, 404 included; the base path means `/` is not
 * necessarily routable and answering at all is the thing being proven. */
function waitForEditorReady(deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpRequest(
        { host: "127.0.0.1", port: EDITOR_PORT, path: "/", method: "GET", timeout: 4000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      const retry = () => {
        req.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`editor did not serve HTTP on ${EDITOR_PORT} in time`));
          return;
        }
        setTimeout(attempt, 250);
      };
      req.once("error", retry);
      req.once("timeout", retry);
      req.end();
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

  startingFor = waitForEditorReady(Date.now() + START_TIMEOUT_MS)
    .then(() => {
      log("editor is serving HTTP");
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
  // lastUsed starts at process start, so a workspace nobody connects to drops its
  // editor one idle window after boot -- which is exactly the case this exists
  // for: an agent-only session pays for the editor once, briefly, and then not at
  // all until somebody opens it.
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

  // One retry before giving up on the client: a first start that loses its race
  // (the editor died on boot, a transient bind failure) should cost this
  // connection a second attempt rather than a failed page load.
  startEditor()
    .catch((first) => {
      log(`first start attempt failed (${first.message}); retrying once`);
      return startEditor();
    })
    .then(() => {
      const upstream = connect({ port: EDITOR_PORT, host: "127.0.0.1" });
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    })
    .catch((err) => {
      log(`giving up on this connection: ${err.message}`);
      client.destroy();
    });
});

proxy.listen(PUBLIC_PORT, "0.0.0.0", () => {
  log(`listening on ${PUBLIC_PORT}; idles out after ${Math.round(IDLE_MS / 60000)}m`);
  // Start warming immediately rather than waiting for the first connection.
  //
  // Lazy-on-first-connection put OpenVSCode's cold start INSIDE the first
  // request's latency budget, and the in-app proxy at /w/<id>/ bounds an upstream
  // request at 30s (WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS). A cold editor on a
  // loaded runner does not finish inside that, so the proxy destroyed the
  // connection and the browser got a failed page load -- which is what the live
  // IDE e2e was reporting. Raising that timeout would only make a genuine
  // upstream failure take longer to surface.
  //
  // The task has just started, so nothing is waiting on this: the editor warms
  // while the workspace finishes coming up, and a user's first request meets a
  // server that is already serving. The saving this whole design exists for is
  // unaffected, because it comes from the IDLE stop, not from refusing to start:
  // a workspace nobody opens drops the editor after IDLE_MS and does not restart
  // it until someone actually connects.
  startEditor().catch((err) => log(`initial warm failed (a connection will retry): ${err.message}`));
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
