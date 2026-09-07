// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseGitRemote, type GitRemote } from "@edd/core";
import { describe, expect, it } from "vitest";

import ssh2 from "ssh2";

import { probeGitRemoteOverHttps, probeGitRemoteOverSsh, refAdvertisementUrl } from "./git-remote";

/** pkt-line framing as a git host emits it: 4-hex length (self-inclusive) + payload. */
function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

const SHA = "a".repeat(40);
const ADVERTISEMENT =
  pkt("# service=git-upload-pack\n") +
  "0000" +
  pkt(`${SHA} HEAD\0symref=HEAD:refs/heads/main agent=git/2.45\n`) +
  pkt(`${SHA} refs/heads/main\n`) +
  pkt(`${SHA} refs/heads/feature/x\n`) +
  pkt(`${SHA} refs/tags/v1.0.0\n`) +
  "0000";

const ADVERTISEMENT_HEADERS = { "content-type": "application/x-git-upload-pack-advertisement" };

function httpsRemote(url: string): GitRemote & { transport: "https" } {
  const remote = parseGitRemote(url);
  if (remote?.transport !== "https") throw new Error(`not https: ${url}`);
  return remote;
}

describe("refAdvertisementUrl", () => {
  it("appends info/refs with the upload-pack service, with or without .git", () => {
    expect(refAdvertisementUrl(httpsRemote("https://github.com/e6qu/pos3ql.git"))).toBe(
      "https://github.com/e6qu/pos3ql.git/info/refs?service=git-upload-pack",
    );
    expect(refAdvertisementUrl(httpsRemote("https://github.com/e6qu/pos3ql/"))).toBe(
      "https://github.com/e6qu/pos3ql/info/refs?service=git-upload-pack",
    );
  });
});

describe("probeGitRemoteOverHttps", () => {
  const url = "https://git.example/acme/app.git";
  const remote = httpsRemote(url);

  function fetchAnswering(response: Response): {
    fetchImpl: typeof fetch;
    calls: { url: string; authorization: string | null }[];
  } {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: headers.get("authorization") });
      return Promise.resolve(response);
    };
    return { fetchImpl, calls };
  }

  it("asks for the ref advertisement anonymously when there is no credential", async () => {
    const { fetchImpl, calls } = fetchAnswering(
      new Response(ADVERTISEMENT, { status: 200, headers: ADVERTISEMENT_HEADERS }),
    );
    const probe = await probeGitRemoteOverHttps(remote, null, fetchImpl);
    expect(probe).toEqual({
      kind: "reachable",
      refs: ["HEAD", "refs/heads/main", "refs/heads/feature/x", "refs/tags/v1.0.0"],
    });
    expect(calls).toEqual([
      { url: `${url}/info/refs?service=git-upload-pack`, authorization: null },
    ]);
  });

  it("offers the credential as HTTP Basic auth, as git's helper does", async () => {
    const { fetchImpl, calls } = fetchAnswering(
      new Response(ADVERTISEMENT, { status: 200, headers: ADVERTISEMENT_HEADERS }),
    );
    await probeGitRemoteOverHttps(remote, { username: "x-access-token", token: "t0k" }, fetchImpl);
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from("x-access-token:t0k").toString("base64")}`,
    );
  });

  it.each([401, 403, 404])("reports HTTP %i as unavailable (not found or private)", async (s) => {
    const { fetchImpl } = fetchAnswering(new Response("", { status: s }));
    expect(await probeGitRemoteOverHttps(remote, null, fetchImpl)).toEqual({
      kind: "unavailable",
      detail: `HTTP ${String(s)}`,
    });
  });

  it("reports a non-advertisement 200 (an HTML page) as unreachable", async () => {
    const { fetchImpl } = fetchAnswering(
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const probe = await probeGitRemoteOverHttps(remote, null, fetchImpl);
    expect(probe.kind).toBe("unreachable");
  });

  it("reports a server error and a thrown fetch as unreachable, never throwing", async () => {
    const { fetchImpl } = fetchAnswering(new Response("", { status: 502 }));
    expect(await probeGitRemoteOverHttps(remote, null, fetchImpl)).toEqual({
      kind: "unreachable",
      detail: "the host answered HTTP 502",
    });
    const failing: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    expect(await probeGitRemoteOverHttps(remote, null, failing)).toEqual({
      kind: "unreachable",
      detail: "ECONNREFUSED",
    });
  });
});

describe("probeGitRemoteOverSsh", () => {
  it("is unavailable without any identity, naming the fix, before touching the network", async () => {
    const remote = parseGitRemote("git@github.com:e6qu/pos3ql.git");
    if (remote?.transport !== "ssh") throw new Error("expected ssh");
    expect(await probeGitRemoteOverSsh(remote, [], [])).toEqual({
      kind: "unavailable",
      detail: "you have no GitHub SSH keys yet",
    });
  });

  it("reports a host that refuses the connection as unreachable, never throwing", async () => {
    const remote = parseGitRemote("ssh://git@127.0.0.1:1/acme/app.git");
    if (remote?.transport !== "ssh") throw new Error("expected ssh");
    const probe = await probeGitRemoteOverSsh(
      remote,
      [{ label: "k", privateKey: ssh2.utils.generateKeyPairSync("ed25519").private }],
      [],
    );
    expect(probe.kind).toBe("unreachable");
  });
});
