// SPDX-License-Identifier: AGPL-3.0-or-later
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorServer } from "./server";

const TOKEN = "unit-test-connection-token-not-secret";
const BASE = "/w/ws-1/";

let root: string;
let spaDir: string;
let server: Server;
let origin: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "edd-root-"));
  spaDir = await fs.mkdtemp(path.join(os.tmpdir(), "edd-spa-"));
  await fs.writeFile(path.join(spaDir, "index.html"), "<!doctype html><title>spa</title>");
  await fs.writeFile(path.join(root, "main.go"), "package main");

  server = createEditorServer({ root, spaDir, basePath: BASE, token: TOKEN });
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(spaDir, { recursive: true, force: true });
});

const cookie = { cookie: `edd-editor-token=${TOKEN}` };

describe("editor server auth", () => {
  it("rejects requests with no/invalid token", async () => {
    expect((await fetch(`${origin}${BASE}api/tree`)).status).toBe(401);
    expect(
      (await fetch(`${origin}${BASE}api/tree`, { headers: { cookie: "edd-editor-token=nope" } }))
        .status,
    ).toBe(401);
  });

  it("accepts a ?tkn query, sets the cookie, and redirects to the clean URL", async () => {
    const res = await fetch(`${origin}${BASE}?tkn=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("edd-editor-token=");
    expect(res.headers.get("location")).toBe(BASE);
  });
});

describe("editor server file API", () => {
  it("lists, reads, and writes files (round-trip), with the cookie", async () => {
    const tree: unknown = await (
      await fetch(`${origin}${BASE}api/tree`, { headers: cookie })
    ).json();
    expect(JSON.stringify(tree)).toContain("main.go");

    const read = await fetch(`${origin}${BASE}api/file?path=main.go`, { headers: cookie });
    expect(await read.text()).toBe("package main");

    const put = await fetch(`${origin}${BASE}api/file?path=notes/todo.md`, {
      method: "PUT",
      headers: cookie,
      body: "# todo",
    });
    expect(put.status).toBe(200);
    const back = await fetch(`${origin}${BASE}api/file?path=notes/todo.md`, { headers: cookie });
    expect(await back.text()).toBe("# todo");
  });

  it("rejects a path that escapes the workspace root", async () => {
    const res = await fetch(
      `${origin}${BASE}api/file?path=${encodeURIComponent("../../etc/passwd")}`,
      {
        headers: cookie,
      },
    );
    expect(res.status).toBe(400);
  });

  it("serves the SPA shell for the base path", async () => {
    const res = await fetch(`${origin}${BASE}`, { headers: cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });
});
