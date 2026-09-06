// SPDX-License-Identifier: AGPL-3.0-or-later
import { listWorkspacesResponse, workspace } from "@edd/api-contracts";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, dropTable, dynamodb, ensureTable, makeBaseImageEntity } from "@edd/db";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { GET, POST } from "./route";

const TEST_TABLE = "ecs-dev-desktop-web-integ";

process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.AWS_ENDPOINT_URL ??= dynamodb.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;

const url = "http://localhost/api/workspaces";

/**
 * A minimal git host speaking the one protocol surface the create check uses: the
 * smart-HTTP ref advertisement. `/acme/app.git` exists (branch `main`, tag `v1`);
 * every other path answers as GitHub does for a private or nonexistent repository
 * (401 + Basic challenge). The create request only ever sees this host's URL, exactly
 * as it would see github.com's. It serves real TLS (the contract only accepts https —
 * the check may carry the owner's credential) under a throwaway certificate that is
 * trusted for this process only.
 */
function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}
const SHA = "b".repeat(40);
const ADVERTISEMENT =
  pkt("# service=git-upload-pack\n") +
  "0000" +
  pkt(`${SHA} HEAD\0symref=HEAD:refs/heads/main\n`) +
  pkt(`${SHA} refs/heads/main\n`) +
  pkt(`${SHA} refs/tags/v1\n`) +
  "0000";

function throwawayCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "edd-git-host-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function startGitHost(): Promise<{ server: Server; baseUrl: string; restoreTrust: () => void }> {
  const { key, cert } = throwawayCertificate();
  const trusted = getCACertificates("default");
  setDefaultCACertificates([...trusted, cert]);
  const restoreTrust = () => {
    setDefaultCACertificates(trusted);
  };
  const server = createServer({ key, cert }, (req, res) => {
    if (req.url === "/acme/app.git/info/refs?service=git-upload-pack") {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      res.end(ADVERTISEMENT);
      return;
    }
    res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `https://127.0.0.1:${port.toString()}`, restoreTrust });
    });
  });
}
const headers = {
  [USER_ID_HEADER]: "alice",
  [ROLE_HEADER]: "developer",
  "content-type": "application/json",
};

describe("workspaces API end-to-end (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    // Seed the catalog: workspaces may only launch from an enabled entry.
    await new CatalogService({
      baseImages: makeBaseImageEntity(client, TEST_TABLE),
      clock: systemClock,
    }).create({ name: "Node 20", image: baseImage("golden/node:20") });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("creates (201) then lists the workspace for its owner", async () => {
    const createRes = await POST(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseImage: "golden/node:20" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdJson: unknown = await createRes.json();
    const ws = workspace.parse(createdJson);
    expect(ws.ownerId).toBe("alice");

    const listRes = await GET(new Request(url, { headers }));
    expect(listRes.status).toBe(200);
    const listJson: unknown = await listRes.json();
    const body = listWorkspacesResponse.parse(listJson);
    expect(body.workspaces.map((w) => w.id)).toContain(ws.id);
  });

  it("rejects creating from an image that is not in the catalog (409)", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseImage: "golden/not-in-catalog:1" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  describe("session repository check", () => {
    let host: Server;
    let gitBase: string;
    let restoreTrust: () => void;
    beforeAll(async () => {
      ({ server: host, baseUrl: gitBase, restoreTrust } = await startGitHost());
    });
    afterAll(() => {
      host.close();
      restoreTrust();
    });

    const create = (body: Record<string, unknown>) =>
      POST(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ baseImage: "golden/node:20", ...body }),
        }),
      );

    it("creates (201) a session from a repository the host advertises, at a real branch", async () => {
      const res = await create({ repoUrl: `${gitBase}/acme/app.git`, repoRef: "main" });
      expect(res.status).toBe(201);
      expect(workspace.parse(await res.json()).repoUrl).toBe(`${gitBase}/acme/app.git`);
    });

    it("accepts a tag as the ref", async () => {
      expect((await create({ repoUrl: `${gitBase}/acme/app.git`, repoRef: "v1" })).status).toBe(
        201,
      );
    });

    it("refuses (422) a repository the host will not advertise, naming the URL and the fix", async () => {
      const res = await create({ repoUrl: `${gitBase}/acme/typo.git` });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(`${gitBase}/acme/typo.git was not found, or it is private`);
      expect(body.error).toContain("connect your Git account");
    });

    it("refuses (422) a ref the repository does not have", async () => {
      const res = await create({ repoUrl: `${gitBase}/acme/app.git`, repoRef: "trunk" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe(
        `${gitBase}/acme/app.git has no branch or tag named 'trunk'.`,
      );
    });

    it("refuses (422) a host that cannot be reached, rather than creating a doomed session", async () => {
      const res = await create({ repoUrl: "https://127.0.0.1:1/acme/app.git" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(/could not be reached/);
    });
  });

  it("enforces the per-role workspace quota (409 when reached)", async () => {
    process.env.EDD_QUOTA_DEVELOPER = "1";
    const h = {
      [USER_ID_HEADER]: "quotaperson",
      [ROLE_HEADER]: "developer",
      "content-type": "application/json",
    };
    const body = JSON.stringify({ baseImage: "golden/node:20" });
    try {
      const first = await POST(new Request(url, { method: "POST", headers: h, body }));
      expect(first.status).toBe(201);
      const second = await POST(new Request(url, { method: "POST", headers: h, body }));
      expect(second.status).toBe(409);
    } finally {
      delete process.env.EDD_QUOTA_DEVELOPER;
    }
  });
});
