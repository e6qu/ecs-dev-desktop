// SPDX-License-Identifier: AGPL-3.0-or-later
// Resumption of the in-workspace idle-agent's heartbeat AFTER a control-plane
// outage. The agent's in-container liveness (it beats and advances lastActivity)
// is already proven by the user-journey e2e; what was untested is that it TOLERATES
// the control plane going away and RESUMES once it returns — behaviour that lives
// entirely in idle-agent.sh's loop. So this drives the real script (sh + curl, the
// exact retry flags) against a stub control plane we toggle down → up. No container
// or sim needed, so it is deterministic — time is controlled via the 1s interval and
// relative polling (AGENTS.md §6.10), never the wall clock.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The idle-agent shipped in the golden base image — the unit under test.
const AGENT_SCRIPT = join(import.meta.dirname, "../../../infra/images/base/idle-agent.sh");
const HEARTBEAT_INTERVAL_S = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll `predicate` until true or the deadline; fail loudly on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

interface StubControlPlane {
  readonly server: Server;
  readonly port: number;
  /** Heartbeats the control plane has ACKed with HTTP 200. */
  ackedBeats: () => number;
  /** Toggle availability: while down, the heartbeat route returns 503. */
  setAvailable: (up: boolean) => void;
}

async function startStubControlPlane(): Promise<StubControlPlane> {
  let available = true;
  let acked = 0;
  const server = createServer((_req, res) => {
    if (!available) {
      res.statusCode = 503;
      res.end("control plane unavailable");
      return;
    }
    acked += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub CP has no TCP port");
  return {
    server,
    port: address.port,
    ackedBeats: () => acked,
    setAvailable: (up) => {
      available = up;
    },
  };
}

function spawnAgent(port: number): ChildProcess {
  return spawn("sh", [AGENT_SCRIPT], {
    env: {
      ...process.env,
      EDD_WORKSPACE_ID: "ws-resume-test",
      EDD_CONTROL_PLANE_URL: `http://127.0.0.1:${String(port)}`,
      EDD_AGENT_TOKEN: "resume-test-token",
      EDD_HEARTBEAT_INTERVAL_S: String(HEARTBEAT_INTERVAL_S),
      // No real editor runs here, so the boot-tolerant IDE probe would otherwise
      // retry ~60s and delay the first beat past this test's wait. One probe.
      EDD_IDE_PROBE_TRIES: "1",
    },
    stdio: "ignore",
  });
}

describe("idle-agent heartbeat resumption after a control-plane outage", () => {
  let cp: StubControlPlane;
  let agent: ChildProcess;

  beforeEach(async () => {
    cp = await startStubControlPlane();
    agent = spawnAgent(cp.port);
  });

  afterEach(async () => {
    agent.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      cp.server.close(() => {
        resolve();
      });
    });
  });

  it("tolerates the control plane going away and resumes beating once it returns", async () => {
    // 1. While the control plane is up, the agent beats.
    await waitFor(() => cp.ackedBeats() >= 1, 15_000, "the first heartbeat");

    // 2. The control plane goes away. Beats now 503; the agent must keep running
    //    (a transient outage must not kill the workspace process) and land no acks.
    cp.setAvailable(false);
    await sleep(500); // let any in-flight beat settle before sampling
    const ackedWhileDown = cp.ackedBeats();
    await sleep((HEARTBEAT_INTERVAL_S * 3 + 1) * 1000); // span several missed beats
    expect(cp.ackedBeats(), "the 'down' control plane acked a heartbeat").toBe(ackedWhileDown);
    expect(
      agent.exitCode,
      "the agent exited during the outage instead of tolerating it",
    ).toBeNull();

    // 3. The control plane returns — the agent resumes (a NEW beat lands after recovery).
    const ackedBeforeRecovery = cp.ackedBeats();
    cp.setAvailable(true);
    await waitFor(
      () => cp.ackedBeats() > ackedBeforeRecovery,
      20_000,
      "a heartbeat after the control plane recovered",
    );
  });
});
