// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  parseGitRemote,
  parseRefAdvertisement,
  refIsAdvertised,
  repoRef,
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

describe("parseGitRemote", () => {
  it("normalises an https clone URL, dropping query and fragment", () => {
    expect(parseGitRemote("https://github.com/e6qu/pos3ql?tab=readme#top")).toEqual({
      transport: "https",
      url: "https://github.com/e6qu/pos3ql",
      host: "github.com",
      path: "e6qu/pos3ql",
    });
    expect(parseGitRemote("https://github.com/e6qu/pos3ql.git/")?.url).toBe(
      "https://github.com/e6qu/pos3ql.git",
    );
  });

  it("reads git's scp-like syntax as ssh with the default user and port", () => {
    expect(parseGitRemote("git@github.com:e6qu/pos3ql.git")).toEqual({
      transport: "ssh",
      url: "ssh://git@github.com/e6qu/pos3ql.git",
      host: "github.com",
      port: 22,
      user: "git",
      path: "e6qu/pos3ql.git",
    });
    const bareHost = parseGitRemote("github.com:e6qu/pos3ql.git");
    expect(bareHost?.transport === "ssh" ? bareHost.user : null).toBe("git");
  });

  it("reads an ssh:// URL, keeping a non-default port", () => {
    expect(parseGitRemote("ssh://git@ghe.example:2222/org/app.git")).toEqual({
      transport: "ssh",
      url: "ssh://git@ghe.example:2222/org/app.git",
      host: "ghe.example",
      port: 2222,
      user: "git",
      path: "org/app.git",
    });
    expect(parseGitRemote("ssh://ghe.example/org/app.git")?.url).toBe(
      "ssh://git@ghe.example/org/app.git",
    );
  });

  it("rejects other schemes, hosts without a path, and junk", () => {
    for (const bad of [
      "",
      "not a url",
      "http://github.com/e6qu/pos3ql",
      "git://github.com/e6qu/pos3ql",
      "https://github.com/",
      "git@github.com:",
      "ssh://git@github.com",
      "ssh://git@github.com:notaport/x",
    ]) {
      expect(parseGitRemote(bad), bad).toBeNull();
    }
  });

  it("never throws and always yields a non-empty host and path (property)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl()), (input) => {
        const remote = parseGitRemote(input);
        if (remote !== null) {
          expect(remote.host.length).toBeGreaterThan(0);
          expect(remote.path.length).toBeGreaterThan(0);
          expect(remote.url.startsWith(remote.transport === "ssh" ? "ssh://" : "https://")).toBe(
            true,
          );
        }
      }),
    );
  });

  it("is idempotent on its own normalised URL (property)", () => {
    // Names start with an alphanumeric, as GitHub requires — a name of only dots is a
    // path traversal `new URL` collapses, not a repository.
    const owner = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,11}$/);
    const repo = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/);
    fc.assert(
      fc.property(owner, repo, fc.boolean(), (o, r, ssh) => {
        const input = ssh ? `git@github.com:${o}/${r}` : `https://github.com/${o}/${r}`;
        const once = parseGitRemote(input);
        expect(once).not.toBeNull();
        if (once !== null) expect(parseGitRemote(once.url)).toEqual(once);
      }),
    );
  });
});

describe("repoRef", () => {
  it("names the owner and repository, stripping .git", () => {
    expect(repoRef(parseGitRemote("https://github.com/e6qu/pos3ql.git") ?? undefined)).toEqual({
      owner: "e6qu",
      name: "pos3ql",
    });
    expect(repoRef(parseGitRemote("git@github.com:e6qu/pos3ql") ?? undefined)).toEqual({
      owner: "e6qu",
      name: "pos3ql",
    });
  });
  it("is undefined without both segments or a remote", () => {
    expect(repoRef(undefined)).toBeUndefined();
    expect(repoRef(parseGitRemote("https://github.com/owner-only") ?? undefined)).toBeUndefined();
    expect(repoRef(parseGitRemote("https://github.com/o/.git") ?? undefined)).toBeUndefined();
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

  it("reads a bannerless advertisement (the SSH git-upload-pack shape)", () => {
    const body = pkt(`${SHA} HEAD\0caps\n`) + pkt(`${SHA} refs/heads/main\n`) + "0000";
    expect(parseRefAdvertisement(body)).toEqual(["HEAD", "refs/heads/main"]);
  });

  it("returns the refs parsed so far from a truncated body, never throwing", () => {
    const truncated = ADVERTISEMENT.slice(0, ADVERTISEMENT.indexOf("refs/heads/feature") + 5);
    expect(parseRefAdvertisement(truncated)).toEqual(["HEAD", "refs/heads/main"]);
  });

  it("never throws on arbitrary bodies and only yields non-empty names (property)", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        for (const ref of parseRefAdvertisement(body)) expect(ref.length).toBeGreaterThan(0);
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
    expect(repositoryProblem(reachable, url, undefined, "none")).toBeNull();
    expect(repositoryProblem(reachable, url, "main", "none")).toBeNull();
  });

  it("names the missing branch or tag", () => {
    expect(repositoryProblem(reachable, url, "trunk", "none")).toBe(
      `${url} has no branch or tag named 'trunk'.`,
    );
  });

  it("explains not-found-or-private by what was offered", () => {
    const unavailable: GitRemoteProbe = { kind: "unavailable", detail: "HTTP 401" };
    expect(repositoryProblem(unavailable, url, undefined, "none")).toContain(
      "connect your Git account",
    );
    expect(repositoryProblem(unavailable, url, undefined, "token")).toContain(
      "your connected Git account cannot read it",
    );
    expect(repositoryProblem(unavailable, url, undefined, "ssh-keys")).toContain(
      "none of your GitHub SSH keys can read it (HTTP 401)",
    );
  });

  it("passes the host failure through", () => {
    expect(
      repositoryProblem({ kind: "unreachable", detail: "fetch failed" }, url, undefined, "none"),
    ).toBe(`${url} could not be reached: fetch failed`);
  });
});
