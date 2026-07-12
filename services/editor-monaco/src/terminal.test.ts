// SPDX-License-Identifier: AGPL-3.0-or-later
// The WS token gate + the client-message protocol are unit-tested here. Spawning a real PTY needs
// a TTY the unit sandbox forbids (posix_spawnp), so the live shell bridge is validated end-to-end
// by the container e2e (where a real shell runs in the workspace).
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEditorServer } from "./server";
import { closeServer, listenOnLoopback } from "./test-server";
import { attachTerminal, parseMessage, type PtyLike } from "./terminal";

describe("parseMessage", () => {
  it("accepts input + resize frames and rejects anything else", () => {
    expect(parseMessage(JSON.stringify({ type: "input", data: "ls\r" }))).toEqual({
      input: "ls\r",
    });
    expect(parseMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "input" }))).toBeNull(); // no data
    expect(parseMessage(JSON.stringify({ type: "resize", cols: "x", rows: 1 }))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "evil" }))).toBeNull();
  });
});

describe("terminal websocket gate", () => {
  let server: Server | undefined;
  let port: number;
  let root: string;
  let spaDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "edd-term-"));
    spaDir = await fs.mkdtemp(path.join(os.tmpdir(), "edd-spa-"));
    server = createEditorServer({ root, spaDir, basePath: "/w/ws-term/", token: "tok-secret" });
    port = await listenOnLoopback(server);
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(spaDir, { recursive: true, force: true });
  });

  it("rejects the upgrade without a valid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/w/ws-term/terminal`);
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => {
        resolve(true);
      });
      ws.on("close", () => {
        resolve(true);
      });
      ws.on("open", () => {
        resolve(false);
      });
    });
    expect(rejected).toBe(true);
  });
});

// A fake PTY so the close→kill lifecycle can be asserted without spawning a real TTY (which the
// unit sandbox forbids). Records kill() calls and lets the test drive the PTY's exit.
function fakePty(): {
  pty: PtyLike;
  rec: { killed: number; onData: ((data: string) => void) | null };
  fireExit: () => void;
} {
  const rec: { killed: number; onData: ((data: string) => void) | null } = {
    killed: 0,
    onData: null,
  };
  let onExit: (() => void) | null = null;
  const pty: PtyLike = {
    onData: (listener) => {
      rec.onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      rec.killed += 1;
    },
  };
  return {
    pty,
    rec,
    fireExit: () => onExit?.(),
  };
}

/** Open a terminal WS to `server` and resolve once the shell is fully wired (the WELCOME banner
 * is the first server write, sent right before the close/exit handlers are registered). */
async function openWiredTerminal(server: Server, wsPath: string): Promise<WebSocket> {
  const port = await listenOnLoopback(server);
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${wsPath}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("message", () => {
      resolve();
    });
    ws.on("error", reject);
  });
  return ws;
}

describe("terminal PTY lifecycle (no stale session)", () => {
  let server: Server | undefined;
  const root = os.tmpdir();

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("kills the PTY when the tab's socket closes", async () => {
    const fake = fakePty();
    server = createServer();
    attachTerminal(server, {
      root,
      basePath: "/w/ws-close/",
      spawnPty: () => Promise.resolve(fake.pty),
    });
    const ws = await openWiredTerminal(server, "/w/ws-close/terminal");
    expect(fake.rec.killed).toBe(0);
    ws.close();
    await vi.waitFor(() => {
      expect(fake.rec.killed).toBe(1);
    });
  });

  it("closes the socket when the PTY exits", async () => {
    const fake = fakePty();
    server = createServer();
    attachTerminal(server, {
      root,
      basePath: "/w/ws-exit/",
      spawnPty: () => Promise.resolve(fake.pty),
    });
    const ws = await openWiredTerminal(server, "/w/ws-exit/terminal");
    const closed = new Promise<void>((resolve) => {
      ws.on("close", () => {
        resolve();
      });
    });
    fake.fireExit();
    await closed;
  });

  it("kills a PTY that finishes spawning after the socket already closed (raced close)", async () => {
    const fake = fakePty();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = createServer();
    attachTerminal(server, {
      root,
      basePath: "/w/ws-race/",
      spawnPty: async () => {
        await gate;
        return fake.pty;
      },
    });
    const port = await listenOnLoopback(server);
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/w/ws-race/terminal`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        resolve();
      });
      ws.on("error", reject);
    });
    // Close BEFORE the spawn resolves, then let it resolve: the raced-close guard must kill it.
    ws.close();
    await new Promise<void>((resolve) => {
      ws.on("close", () => {
        resolve();
      });
    });
    release();
    await vi.waitFor(() => {
      expect(fake.rec.killed).toBe(1);
    });
    // It never wired the data bridge for a socket that was already gone.
    expect(fake.rec.onData).toBeNull();
  });
});
