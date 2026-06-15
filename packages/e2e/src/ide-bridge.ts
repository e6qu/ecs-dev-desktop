// SPDX-License-Identifier: AGPL-3.0-or-later
// IDE bridge: reach a sim-launched workspace task's OpenVSCode workbench from the
// host. The sim runs each ECS task in an awsvpc network namespace that is NOT
// attached to any host-reachable Docker network (peer tasks reach it in-network;
// the host cannot route to its ENI). The one reliable channel into that netns is
// `docker exec`, so this opens a local TCP listener and, per connection, pipes
// the stream through `docker exec -i <task> python3` to the workbench on
// 127.0.0.1:3000 inside the task.
//
// This is the LOCAL/dev + sim-CI realisation of the per-workspace proxy handoff
// (the production reach is the identity-aware proxy + CONNECTION_TOKEN handoff).
// It is a harness/operator tool — never part of app or contract logic.
import { spawn, execFileSync } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";

/** OpenVSCode's in-container HTTP port (the golden image's `--port 3000`). */
const WORKBENCH_PORT = 3000;

/** A stdio<->TCP relay, run inside the task via python3 (the golden image has no
 * nc/socat but does have python3): copy stdin→socket and socket→stdout. */
const INNER_RELAY = [
  "import sys,socket,threading",
  `s=socket.create_connection(('127.0.0.1',${String(WORKBENCH_PORT)}))`,
  "def up():",
  " while True:",
  "  d=sys.stdin.buffer.read1(65536)",
  "  if not d: break",
  "  s.sendall(d)",
  "def dn():",
  " while True:",
  "  d=s.recv(65536)",
  "  if not d: break",
  "  sys.stdout.buffer.write(d); sys.stdout.buffer.flush()",
  "t=threading.Thread(target=up,daemon=True); t.start(); dn()",
].join("\n");

export interface IdeBridge {
  /** Browser URL for the workbench (includes `?tkn=` when the task uses a token). */
  readonly url: string;
  /** The OpenVSCode connection token in effect, or undefined if tokenless. */
  readonly token: string | undefined;
  /** Local listener port. */
  readonly port: number;
  /** The sim task container the bridge targets. */
  readonly container: string;
  /** Stop the listener (does not stop the task). */
  close: () => void;
}

export interface IdeBridgeOptions {
  workspaceId: string;
  /** Workspace image whose running container to find (default edd-workspace:e2e). */
  image?: string;
  /** Listener port; 0 (default) picks a free one. */
  port?: number;
}

/** Container ids (one per line) for `docker ps`/`docker ps -a`. */
function containerIds(all: boolean): string[] {
  const args = all ? ["ps", "-aq"] : ["ps", "-q"];
  return execFileSync("docker", args, { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A container's EDD_WORKSPACE_ID env value, or undefined. */
function containerWorkspaceId(id: string): string | undefined {
  const env = execFileSync(
    "docker",
    ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", id],
    { encoding: "utf8" },
  );
  const m = /^EDD_WORKSPACE_ID=(.*)$/m.exec(env);
  return m?.[1] === undefined ? undefined : m[1].trim();
}

/**
 * Find the RUNNING sim task container for a workspace by its EDD_WORKSPACE_ID env.
 * Scans all running containers rather than filtering by image (the sim may launch
 * the task under an image ref an `ancestor=` filter won't match — e.g. a
 * pulled-then-retagged image), so the workspace-id env is the only reliable key.
 *
 * On miss, builds a diagnostic error: if a matching container exists but is not
 * running (it started then exited — e.g. OOM/crash under a constrained VM), its
 * status, exit code and last logs are included so a CI failure is self-explaining
 * (the test's own teardown would otherwise stop+remove it before any later step).
 */
function findTaskContainer(workspaceId: string, image: string): string {
  // Brief retry: the sim can report a task RUNNING a beat before its container
  // surfaces in `docker ps` on a slow VM. A crashed container never becomes
  // running, so this never masks a real failure (the diagnostics below catch it).
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const id of containerIds(false)) {
      if (containerWorkspaceId(id) === workspaceId) return id;
    }
    execFileSync("sleep", ["1"]);
  }
  // Not running — look for an exited instance to explain why.
  for (const id of containerIds(true)) {
    if (containerWorkspaceId(id) !== workspaceId) continue;
    const state = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} {{.State.Error}}", id],
      { encoding: "utf8" },
    ).trim();
    const logs = execFileSync("docker", ["logs", "--tail", "60", id], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error(
      `task container for workspace ${workspaceId} is not running (${state}).\n--- container logs ---\n${logs}`,
    );
  }
  const psa = execFileSync("docker", ["ps", "-a"], { encoding: "utf8" });
  throw new Error(
    `no task container for workspace ${workspaceId} (expected image ${image}); no matching container exists.\n--- docker ps -a ---\n${psa}`,
  );
}

/** Extract the OpenVSCode `--connection-token` from the task's process args, or
 * undefined if the server runs `--without-connection-token`. The task reaches ECS
 * RUNNING (and the bridge is opened) before the entrypoint execs OpenVSCode, so
 * retry until the server process appears rather than racing it. */
function extractToken(container: string): string | undefined {
  for (let attempt = 0; attempt < 60; attempt++) {
    const cmdlines = execFileSync(
      "docker",
      [
        "exec",
        container,
        "sh",
        "-lc",
        'for p in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$p" 2>/dev/null; echo; done',
      ],
      { encoding: "utf8" },
    );
    if (cmdlines.includes("--without-connection-token")) return undefined;
    const m = /connection-token ([^\s]+)/.exec(cmdlines);
    if (m !== null) return m[1];
    execFileSync("sleep", ["1"]);
  }
  throw new Error(`OpenVSCode connection token never appeared in task ${container} (60s)`);
}

/**
 * Open a host→task IDE bridge for a running workspace. Resolves once the local
 * listener is bound; the returned `url` opens the real workbench in a browser.
 */
export async function startIdeBridge(opts: IdeBridgeOptions): Promise<IdeBridge> {
  const image = opts.image ?? "edd-workspace:e2e";
  const container = findTaskContainer(opts.workspaceId, image);
  const token = extractToken(container);

  const server = createServer((sock: Socket) => {
    const child = spawn("docker", ["exec", "-i", container, "python3", "-c", INNER_RELAY], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    sock.pipe(child.stdin);
    child.stdout.pipe(sock);
    const cleanup = (): void => {
      child.kill();
      sock.destroy();
    };
    sock.on("error", cleanup);
    sock.on("close", () => child.kill());
    child.on("error", cleanup);
    child.on("exit", () => sock.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${String(port)}/${token === undefined ? "" : `?tkn=${token}`}`;

  return {
    url,
    token,
    port,
    container,
    close: () => {
      server.close();
    },
  };
}
