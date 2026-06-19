// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `edd` — a thin operator CLI over the control-plane HTTP API (the same `@edd/api-client`
 * SDK + Zod contracts the web UI uses, so it can never drift from the API). Read-focused
 * ops/monitoring commands: is the deployment in sync, healthy, and what's the fleet doing.
 *
 * Config (env):
 *   EDD_API_URL   base URL of the control plane (default http://edd.localhost:3700)
 *   EDD_API_TOKEN bearer token for a real deployment (Authorization: Bearer …), OR
 *   EDD_USER / EDD_ROLE  dev-auth shim identity for a local run (default admin/admin)
 */
import { ApiClient } from "@edd/api-client";
import type { ConfigSyncReportDto } from "@edd/api-contracts";

import { authHeaders, sym } from "./helpers";

const DEFAULT_API_URL = "http://edd.localhost:3700";

function makeClient(env: NodeJS.ProcessEnv): ApiClient {
  const auth = authHeaders(env);
  const baseUrl = env.EDD_API_URL ?? DEFAULT_API_URL;
  return new ApiClient({
    baseUrl,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(auth)) headers.set(k, v);
      return globalThis.fetch(input, { ...init, headers });
    },
  });
}

function printConfigSync(report: ConfigSyncReportDto): void {
  process.stdout.write(`config-sync: ${report.inSync ? "IN SYNC ✓" : "DRIFT ✗"}\n`);
  if (report.identity !== undefined) {
    const who = report.identity.principalArn ?? (report.identity.callerArn || "—");
    process.stdout.write(`  identity: account ${report.identity.account || "—"} · ${who}\n`);
  }
  for (const c of report.checks) {
    process.stdout.write(`  ${sym(c.status)} ${c.name.padEnd(26)} ${c.detail}\n`);
  }
}

const USAGE = `edd — operator CLI for ecs-dev-desktop

Usage: edd <command>

Commands:
  config-sync, doctor   Is the deployment wired the way it should be? (exit 1 on drift)
  health                Dependency health board
  status                Infrastructure summary (cluster + fleet)
  workspaces, ls        List workspaces

Config: EDD_API_URL, and EDD_API_TOKEN (bearer) or EDD_USER/EDD_ROLE (dev-auth).
`;

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return cmd === undefined ? 1 : 0;
  }
  const client = makeClient(env);
  switch (cmd) {
    case "config-sync":
    case "doctor": {
      const report = await client.adminConfigSync();
      printConfigSync(report);
      return report.inSync ? 0 : 1; // gateable in scripts/CI
    }
    case "health": {
      const report = await client.adminHealth();
      process.stdout.write(`health: ${report.status}\n`);
      for (const c of report.components) {
        process.stdout.write(`  ${sym(c.status)} ${c.component.padEnd(16)} ${c.detail}\n`);
      }
      return report.status === "ok" ? 0 : 1;
    }
    case "status": {
      const infra = await client.adminInfrastructure();
      process.stdout.write(`cluster: ${infra.cluster.status} (${infra.cluster.name})\n`);
      process.stdout.write(
        `fleet: ${infra.fleet.total.toString()} total, ${infra.fleet.active.toString()} active\n`,
      );
      return 0;
    }
    case "workspaces":
    case "ls": {
      const { workspaces } = await client.listWorkspaces();
      for (const w of workspaces) {
        process.stdout.write(`${w.id}\t${w.state}\t${w.baseImage}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(`edd: unknown command '${cmd}'\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2), process.env)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`edd: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
