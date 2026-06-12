// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness: run the REAL control plane (`apps/web`, production `next start`) for
// e2e chains that need it over HTTP — the SSH gateway's wake-on-connect calls,
// the in-workspace idle-agent heartbeats, and the live user journey. The app is
// the production build; only env differs (endpoint-only, §6.8).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const WEB_DIR = join(REPO_ROOT, "apps/web");
const HEALTHZ_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 300_000;

export interface WebApp {
  baseUrl: string;
  stop: () => void;
}

/** A free TCP port from the OS (bind 0, read, release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr !== null) {
        const { port } = addr;
        srv.close(() => {
          resolve(port);
        });
      } else {
        srv.close();
        reject(new Error("could not allocate a free port"));
      }
    });
  });
}

/** Build `apps/web` if the production build is missing (CI prebuilds via `pnpm build`). */
function ensureWebBuilt(): void {
  if (existsSync(join(WEB_DIR, ".next", "BUILD_ID"))) return;
  const res = spawnSync("pnpm", ["--filter", "@edd/web", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    throw new Error(`apps/web build failed:\n${res.stdout}\n${res.stderr}`);
  }
}

/**
 * Start the production web app on a free port with the given env (dev-auth on,
 * DynamoDB Local table of the caller's choosing). Resolves once /api/healthz
 * responds. Caller owns the table lifecycle; `stop()` kills the server.
 *
 * `makeEnv` receives the chosen port so callers can reference the app's own
 * URL in env values (e.g. CONTROL_PLANE_URL injected into workspace tasks).
 */
export async function startWebApp(
  makeEnv: (port: number) => Record<string, string>,
): Promise<WebApp> {
  ensureWebBuilt();
  const port = await freePort();
  const env = makeEnv(port);
  const child: ChildProcess = spawn(
    join(WEB_DIR, "node_modules", ".bin", "next"),
    ["start", "-p", String(port)],
    {
      cwd: WEB_DIR,
      env: { ...process.env, EDD_DEV_AUTH: "1", AUTH_SECRET: "e2e-secret", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + HEALTHZ_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited (${String(child.exitCode)}):\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`web app did not become healthy in time:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    baseUrl,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

/** Dev-auth headers (`EDD_DEV_AUTH=1`) identifying a member/admin over HTTP. */
export function devHeaders(userId: string, role: "member" | "admin"): Record<string, string> {
  return {
    "x-edd-user-id": userId,
    "x-edd-role": role,
    "content-type": "application/json",
  };
}
