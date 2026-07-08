// SPDX-License-Identifier: AGPL-3.0-or-later
const { createHash, timingSafeEqual } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createServer, get } = require("node:http");

const workspaceId = process.env.EDD_WORKSPACE_ID || "";
const mode = process.env.EDD_EDITOR_MODE || "";
const port = Number(process.env.PORT || "3000");
const token =
  process.env.EDD_DISABLE_CONNECTION_TOKEN === "1" ? "" : process.env.CONNECTION_TOKEN || "";
const basePath = workspaceId === "" ? "/" : `/w/${workspaceId}/`;
const cookieName = "edd-vendor-token";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function tokensMatch(a, b) {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return ah.length === bh.length && timingSafeEqual(ah, bh);
}

function tokenFromCookie(cookie) {
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === cookieName) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function vendorCommand() {
  switch (mode) {
    case "claude":
      return {
        command: required("EDD_CLAUDE_COMMAND"),
        args: ["--remote-control", workspaceId],
        exitMode: "long-running",
        pty: true,
        title: "Claude Local Web UI",
        url: "https://claude.ai/code",
        note: "Claude Code Remote Control is running in this workspace. Open the vendor Claude Code web UI and attach to this named local session.",
      };
    case "codex":
      return {
        command: required("EDD_CODEX_COMMAND"),
        args: ["app-server", "--listen", "ws://127.0.0.1:4500"],
        exitMode: "long-running",
        healthUrl: "http://127.0.0.1:4500/healthz",
        title: "Codex Local Web UI",
        url: "codex://app-server",
        note: "Codex app-server is running in this workspace for the first-party Codex client protocol. Open the vendor Codex client and attach to this workspace session.",
      };
    default:
      throw new Error(`unsupported vendor harness mode: ${mode}`);
  }
}

const spec = vendorCommand();

let exited = false;
let exitDetail = "";
let started = spec.exitMode === "long-running";
const recent = [];
function remember(prefix, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line === "") continue;
    recent.push(`${prefix}${line}`);
    while (recent.length > 40) recent.shift();
  }
}

function markExit(code, signal) {
  if (spec.exitMode === "successful-start" && code === 0 && signal === null) {
    started = true;
    exitDetail = "";
    remember("edd: ", "vendor remote-control daemon start completed");
    return;
  }
  exited = true;
  started = false;
  exitDetail = `vendor harness exited with code=${String(code)} signal=${String(signal)}`;
  remember("edd: ", exitDetail);
}

function markSpawnError(err) {
  exited = true;
  started = false;
  exitDetail = `vendor harness spawn failed: ${err.message}`;
  remember("edd: ", exitDetail);
}

function spawnVendor() {
  if (spec.pty === true) {
    try {
      const pty = require("/opt/edd-editor-monaco/node_modules/node-pty");
      const term = pty.spawn(spec.command, spec.args, {
        name: "xterm-color",
        cols: 120,
        rows: 30,
        cwd: "/home/workspace",
        env: process.env,
      });
      term.onData((data) => remember("", data));
      term.onExit(({ exitCode, signal }) => markExit(exitCode, signal));
      return;
    } catch (err) {
      markSpawnError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  const child = spawn(spec.command, spec.args, {
    cwd: "/home/workspace",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => remember("", chunk));
  child.stderr.on("data", (chunk) => remember("stderr: ", chunk));
  child.on("error", markSpawnError);
  child.on("exit", markExit);
}

spawnVendor();

function healthStatus(callback) {
  if (!started || exited) {
    callback(false);
    return;
  }
  if (spec.healthUrl !== undefined) {
    const req = get(spec.healthUrl, (res) => {
      res.resume();
      callback(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("error", (cause) => {
      remember("health stderr: ", cause.message);
      callback(false);
    });
    req.setTimeout(1000, () => {
      req.destroy(new Error("health probe timed out"));
    });
    return;
  }
  if (!started || exited || spec.healthCommand === undefined) {
    callback(!exited && started);
    return;
  }
  const probe = spawn(spec.healthCommand, spec.healthArgs, {
    cwd: "/home/workspace",
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  probe.stderr.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });
  probe.on("error", (cause) => {
    remember("health stderr: ", cause.message);
    callback(false);
  });
  probe.on("exit", (code, signal) => {
    const ok = code === 0 && signal === null;
    if (!ok && err !== "") remember("health stderr: ", err);
    callback(ok);
  });
}

function authenticated(req, res) {
  if (token === "") return true;
  const url = new URL(req.url || "/", "http://workspace");
  const presented = url.searchParams.get("tkn") || tokenFromCookie(req.headers.cookie);
  if (presented === undefined || !tokensMatch(token, presented)) {
    res.statusCode = 401;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("unauthorized");
    return false;
  }
  if (url.searchParams.has("tkn")) {
    url.searchParams.delete("tkn");
    res.statusCode = 302;
    res.setHeader(
      "set-cookie",
      `${cookieName}=${encodeURIComponent(presented)}; Path=${basePath}; SameSite=Lax; HttpOnly`,
    );
    res.setHeader("location", `${url.pathname}${url.search}`);
    res.end();
    return false;
  }
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://workspace");
  if (!url.pathname.startsWith(basePath)) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  if (!authenticated(req, res)) return;
  if (url.pathname.endsWith("/healthz")) {
    healthStatus((running) => {
      res.statusCode = running ? 200 : 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ mode, running, exitDetail }));
    });
    return;
  }
  res.statusCode = !exited && started ? 200 : 503;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(spec.title)}</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#0e1116;color:#e7edf5}
    main{max-width:760px;margin:0 auto;padding:48px 24px}
    a{color:#9fef00}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    pre{white-space:pre-wrap;background:#151b23;border:1px solid #303844;padding:12px;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <p class="mono">${htmlEscape(mode)}</p>
    <h1>${htmlEscape(spec.title)}</h1>
    <p>${htmlEscape(spec.note)}</p>
    <p><a href="${htmlEscape(spec.url)}">${htmlEscape(spec.url)}</a></p>
    <p class="mono">status: ${!exited && started ? "running" : "failed"}</p>
    ${exitDetail === "" ? "" : `<p class="mono">${htmlEscape(exitDetail)}</p>`}
    <h2>Vendor harness log</h2>
    <pre>${htmlEscape(recent.join("\n"))}</pre>
  </main>
</body>
</html>`);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`edd: ${spec.title} harness listening on :${String(port)}${basePath}\n`);
});
