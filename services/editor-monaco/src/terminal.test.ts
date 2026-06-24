// SPDX-License-Identifier: AGPL-3.0-or-later
// The WS token gate + the client-message protocol are unit-tested here. Spawning a real PTY needs
// a TTY the unit sandbox forbids (posix_spawnp), so the live shell bridge is validated end-to-end
// by the container e2e (where a real shell runs in the workspace).
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorServer } from "./server";
import { parseMessage } from "./terminal";

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
  let server: Server;
  let port: number;
  let spaDir: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "edd-term-"));
    spaDir = await fs.mkdtemp(path.join(os.tmpdir(), "edd-spa-"));
    server = createEditorServer({ root, spaDir, basePath: "/w/ws-term/", token: "tok-secret" });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await fs.rm(spaDir, { recursive: true, force: true });
  });

  it("rejects the upgrade without a valid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/w/ws-term/terminal`);
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => {
        resolve(true);
      });
      ws.on("open", () => {
        resolve(false);
      });
    });
    expect(rejected).toBe(true);
  });
});
