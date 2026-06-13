// SPDX-License-Identifier: AGPL-3.0-or-later
// Global setup for the live PEP→PDP gate e2e (playwright.gate.config.ts). The
// gated wildcard route denies every host whose workspace the caller does not
// own, so before the browser test we must seed an OWNED workspace — which means
// first learning the authenticated sim user's email. We drive the OIDC flow to a
// direct (non-gated) auth-probe route, read the email from the echoed Pomerium
// assertion, then seed two workspaces against the same DynamoDB the web/PDP
// container reads: one owned by the sim user, one by someone else. The hosts are
// written to temp/gate-hosts.json for the test. Endpoint-only (AGENTS.md §6.8).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { baseImage, email, ownerId } from "@edd/core";
import { createDynamoClient, ensureTable } from "@edd/db";
import { assertionFromEcho, authedGet, ROUTE_DOMAIN } from "@edd/e2e/pomerium";
import { decodeJwt } from "jose";

import { getControlPlane } from "../lib/control-plane";

const TABLE = process.env.DYNAMODB_TABLE ?? "edd-gate-e2e";
const IMAGE = "golden/node:20";
const HOSTS_FILE = join(import.meta.dirname, "../temp/gate-hosts.json");
const READINESS_ATTEMPTS = 40;
const READINESS_DELAY_MS = 1000;

/** Resolve after `ms` — readiness polling (the test owns its own waiting). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape persisted for the test (apps/web/e2e/workspace-gate.pwgate.ts). */
export interface GateHosts {
  readonly ownerHost: string;
  readonly otherHost: string;
  readonly simEmail: string;
}

export default async function globalSetup(): Promise<void> {
  process.env.DYNAMODB_TABLE = TABLE;
  await ensureTable(createDynamoClient(), TABLE);

  // Learn the authenticated sim user's email from the echoed assertion on the
  // direct auth-probe route (the gated wildcard would deny a not-yet-owned host).
  const { hop } = await authedGet(`auth-probe.${ROUTE_DOMAIN}`);
  if (hop.status !== 200) {
    throw new Error(`auth-probe expected 200, got ${String(hop.status)}`);
  }
  const token = assertionFromEcho(hop.body);
  if (token === undefined) {
    throw new Error("no X-Pomerium-Jwt-Assertion echoed by the auth-probe route");
  }
  const simEmail = decodeJwt(token).email;
  if (typeof simEmail !== "string") {
    throw new Error("the Pomerium assertion must carry an email claim");
  }

  // Seed an owned workspace (sim user) and a non-owned one (someone else).
  const cp = await getControlPlane();
  const owned = await cp.create({
    ownerId: ownerId("u-owner"),
    ownerEmail: email(simEmail),
    baseImage: baseImage(IMAGE),
  });
  const other = await cp.create({
    ownerId: ownerId("u-other"),
    ownerEmail: email("intruder@edd.test"),
    baseImage: baseImage(IMAGE),
  });

  const hosts: GateHosts = {
    ownerHost: `${owned.id}.${ROUTE_DOMAIN}`,
    otherHost: `${other.id}.${ROUTE_DOMAIN}`,
    simEmail,
  };
  mkdirSync(dirname(HOSTS_FILE), { recursive: true });
  writeFileSync(HOSTS_FILE, JSON.stringify(hosts));

  // Wait for the full chain (Pomerium → gate → PDP → upstream) to be ready: right
  // after bring-up the gate's upstream can briefly report unavailable (503/502)
  // until Pomerium sees the gate as healthy. Drive the owner path until it's 200
  // so the browser test is deterministic (no readiness flake), esp. in CI.
  let ready = 0;
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt++) {
    const { hop } = await authedGet(hosts.ownerHost);
    ready = hop.status;
    if (ready === 200) break;
    await delay(READINESS_DELAY_MS);
  }
  if (ready !== 200) {
    throw new Error(`gate chain not ready: owner host last returned ${String(ready)}`);
  }

  process.stdout.write(
    `gate e2e seeded: owner ${hosts.ownerHost}, other ${hosts.otherHost} (user ${simEmail})\n`,
  );
}
