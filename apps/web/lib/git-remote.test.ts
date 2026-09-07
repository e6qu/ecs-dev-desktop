// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  parseRefAdvertisement,
  probeGitRemote,
  refAdvertisementUrl,
  refIsAdvertised,
  repositoryProblem,
  type GitRemoteProbe,
} from "./git-remote";

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

describe("refAdvertisementUrl", () => {
  it("appends info/refs with the upload-pack service, with or without .git", () => {
    expect(refAdvertisementUrl("https://github.com/e6qu/pos3ql.git")).toBe(
      "https://github.com/e6qu/pos3ql.git/info/refs?service=git-upload-pack",
    );
    expect(refAdvertisementUrl("https://github.com/e6qu/pos3ql/")).toBe(
      "https://github.com/e6qu/pos3ql/info/refs?service=git-upload-pack",
    );
  });

  it("drops any query or fragment the user pasted", () => {
    expect(refAdvertisementUrl("https://github.com/e6qu/pos3ql?tab=readme#top")).toBe(
      "https://github.com/e6qu/pos3ql/info/refs?service=git-upload-pack",
    );
  });
});

describe("parseRefAdvertisement", () => {
  it("lists every advertised ref, dropping the banner and capabilities", () => {
    expect(parseRefAdvertisement(ADVERTISEMENT)).toEqual([
      "HEAD",
      "refs/heads/main",
      "refs/heads/feature/x",
      "refs/tags/v1.0.0",
    ]);
  });

  it("returns the refs parsed so far from a truncated body, never throwing", () => {
    const truncated = ADVERTISEMENT.slice(0, ADVERTISEMENT.indexOf("refs/heads/feature") + 5);
    expect(parseRefAdvertisement(truncated)).toEqual(["HEAD", "refs/heads/main"]);
  });

  it("never throws on arbitrary bodies and only yields non-empty names (property)", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const refs = parseRefAdvertisement(body);
        for (const ref of refs) expect(ref.length).toBeGreaterThan(0);
      }),
    );
  });

  it("round-trips any list of ref names through pkt-line framing (property)", () => {
    const refName = fc
      .array(fc.stringMatching(/^[a-zA-Z0-9._-]{1,12}$/), { minLength: 1, maxLength: 4 })
      .map((parts) => `refs/heads/${parts.join("/")}`);
    fc.assert(
      fc.property(fc.array(refName, { maxLength: 20 }), (refs) => {
        const body =
          pkt("# service=git-upload-pack\n") +
          "0000" +
          refs.map((ref) => pkt(`${SHA} ${ref}\n`)).join("") +
          "0000";
        expect(parseRefAdvertisement(body)).toEqual(refs);
      }),
    );
  });
});

describe("refIsAdvertised", () => {
  const refs = ["HEAD", "refs/heads/main", "refs/tags/v1.0.0"];
  it("matches a branch or a tag by its short name", () => {
    expect(refIsAdvertised(refs, "main")).toBe(true);
    expect(refIsAdvertised(refs, "v1.0.0")).toBe(true);
  });
  it("rejects a name that is neither", () => {
    expect(refIsAdvertised(refs, "develop")).toBe(false);
    expect(refIsAdvertised(refs, "HEAD")).toBe(false);
  });
  it("accepts a full commit SHA unverified (tips only are advertised)", () => {
    expect(refIsAdvertised(refs, SHA)).toBe(true);
    expect(refIsAdvertised(refs, SHA.slice(0, 7))).toBe(false);
  });
});

describe("repositoryProblem", () => {
  const reachable: GitRemoteProbe = { kind: "reachable", refs: ["refs/heads/main"] };
  const url = "https://github.com/e6qu/pos3q.git";

  it("is null for a reachable repository with no ref, or an advertised ref", () => {
    expect(repositoryProblem(reachable, url, undefined, false)).toBeNull();
    expect(repositoryProblem(reachable, url, "main", false)).toBeNull();
  });

  it("names the missing branch or tag", () => {
    expect(repositoryProblem(reachable, url, "trunk", false)).toBe(
      `${url} has no branch or tag named 'trunk'.`,
    );
  });

  it("explains not-found-or-private differently with and without a connected account", () => {
    const unavailable: GitRemoteProbe = { kind: "unavailable", status: 401 };
    expect(repositoryProblem(unavailable, url, undefined, false)).toContain(
      "connect your Git account",
    );
    expect(repositoryProblem(unavailable, url, undefined, true)).toContain(
      "your connected Git account cannot read it",
    );
  });

  it("passes the host failure through", () => {
    expect(
      repositoryProblem({ kind: "unreachable", detail: "fetch failed" }, url, undefined, false),
    ).toBe(`${url} could not be reached: fetch failed`);
  });
});

describe("probeGitRemote", () => {
  const url = "https://git.example/acme/app.git";

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
    const probe = await probeGitRemote(url, null, fetchImpl);
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
    await probeGitRemote(url, { username: "x-access-token", token: "t0k" }, fetchImpl);
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from("x-access-token:t0k").toString("base64")}`,
    );
  });

  it.each([401, 403, 404])("reports HTTP %i as unavailable (not found or private)", async (s) => {
    const { fetchImpl } = fetchAnswering(new Response("", { status: s }));
    expect(await probeGitRemote(url, null, fetchImpl)).toEqual({ kind: "unavailable", status: s });
  });

  it("reports a non-advertisement 200 (an HTML page) as unreachable", async () => {
    const { fetchImpl } = fetchAnswering(
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const probe = await probeGitRemote(url, null, fetchImpl);
    expect(probe.kind).toBe("unreachable");
  });

  it("reports a server error and a thrown fetch as unreachable, never throwing", async () => {
    const { fetchImpl } = fetchAnswering(new Response("", { status: 502 }));
    expect(await probeGitRemote(url, null, fetchImpl)).toEqual({
      kind: "unreachable",
      detail: "the host answered HTTP 502",
    });
    const failing: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    expect(await probeGitRemote(url, null, failing)).toEqual({
      kind: "unreachable",
      detail: "ECONNREFUSED",
    });
  });
});
