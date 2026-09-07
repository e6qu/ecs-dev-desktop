// SPDX-License-Identifier: AGPL-3.0-or-later
import { GIT_REMOTE_PROBE_TIMEOUT_MS } from "@edd/config";

/**
 * Create-time check that a session's repository can actually be cloned, done the way git
 * itself starts a clone: a smart-HTTP ref advertisement (`GET <repo>/info/refs?service=
 * git-upload-pack`). It is the one standard surface every git host exposes, so the same
 * call works for GitHub, GHES, or any host the URL names — no provider API involved.
 *
 * Why this exists: a git host answers "authentication required" for a repository that
 * does not exist exactly as it does for a private one, so without this check a typo'd
 * URL sailed through create and only failed minutes later inside the workspace with the
 * opaque `could not read Username for 'https://github.com'` — after the user had already
 * been navigated to a booting session.
 */

/** The outcome of probing a repository URL. */
export type GitRemoteProbe =
  /** The host advertised the repository's refs (it exists and the credential, if any, can read it). */
  | { readonly kind: "reachable"; readonly refs: readonly string[] }
  /** The host refused (401/403) or has no such repository (404): not found, or private
   * and unreadable with the credential offered. Indistinguishable by design on GitHub. */
  | { readonly kind: "unavailable"; readonly status: number }
  /** The host could not be reached or answered outside the protocol. */
  | { readonly kind: "unreachable"; readonly detail: string };

/** A git HTTPS credential (`username:token` for Basic auth), as the workspace helper sends it. */
export interface GitCredential {
  readonly username: string;
  readonly token: string;
}

const GIT_UPLOAD_PACK_SERVICE = "git-upload-pack";
const ADVERTISEMENT_CONTENT_TYPE = "application/x-git-upload-pack-advertisement";
const PKT_LINE_LENGTH_DIGITS = 4;
const PKT_FLUSH = "0000";
/** HTTP statuses a git host uses for "you may not see this repository" (which for a
 * nonexistent repository is the same answer, so existence is not leaked). */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** The `{ owner, name }` from an `https://host/owner/repo(.git)` URL — the owner picks the
 * GitHub App installation, and `name` scopes the minted token to exactly that repo. Undefined
 * when there is no/odd repo URL. Exported for property testing (never throws on arbitrary
 * input). The `.git` suffix (git's own clone URLs carry it) is stripped from the name. */
export function repoRef(repoUrl: string | undefined): { owner: string; name: string } | undefined {
  if (repoUrl === undefined) return undefined;
  try {
    const segments = new URL(repoUrl).pathname.split("/").filter((s) => s.length > 0);
    // Need both an owner and a repo segment (an owner-only URL yields no credential).
    if (segments.length < 2) return undefined;
    const name = segments[1].replace(/\.git$/, "");
    if (name.length === 0) return undefined;
    return { owner: segments[0], name };
  } catch {
    return undefined;
  }
}

/** The `info/refs` URL for a repository clone URL (with or without a `.git` suffix). */
export function refAdvertisementUrl(repoUrl: string): string {
  const url = new URL(repoUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/info/refs`;
  url.search = `service=${GIT_UPLOAD_PACK_SERVICE}`;
  url.hash = "";
  return url.toString();
}

/**
 * Ref names from a smart-HTTP v0 ref advertisement (pkt-line framed:
 * `# service=git-upload-pack`, flush, then `<sha> <ref>[\0caps]` per line). Pure; a
 * malformed body yields the refs parsed so far (never throws). `HEAD` is included.
 */
export function parseRefAdvertisement(body: string): string[] {
  const refs: string[] = [];
  let offset = 0;
  while (offset + PKT_LINE_LENGTH_DIGITS <= body.length) {
    const lengthHex = body.slice(offset, offset + PKT_LINE_LENGTH_DIGITS);
    if (!/^[0-9a-f]{4}$/i.test(lengthHex)) break;
    if (lengthHex === PKT_FLUSH) {
      offset += PKT_LINE_LENGTH_DIGITS;
      continue;
    }
    const length = Number.parseInt(lengthHex, 16);
    // A line that runs past the body is a truncated transfer: stop, never emit a partial ref.
    if (length < PKT_LINE_LENGTH_DIGITS || offset + length > body.length) break;
    const payload = body.slice(offset + PKT_LINE_LENGTH_DIGITS, offset + length);
    offset += length;
    if (payload.startsWith("#")) continue; // the service banner
    const line = payload.split("\0")[0].replace(/\n$/, "");
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const ref = line.slice(space + 1);
    if (ref.length > 0) refs.push(ref);
  }
  return refs;
}

/**
 * Whether `ref` (a branch, tag, or commit as the user typed it) can be checked out from
 * the advertised refs. A full 40-hex SHA is accepted unverified (an advertisement lists
 * only ref tips, so a reachable commit is not knowable here); a short SHA is treated as
 * a name and must match a branch or tag. Pure.
 */
export function refIsAdvertised(refs: readonly string[], ref: string): boolean {
  if (FULL_SHA_PATTERN.test(ref)) return true;
  return refs.includes(`refs/heads/${ref}`) || refs.includes(`refs/tags/${ref}`);
}

/** The user-facing reason a session cannot be created from `repoUrl`, or null when the
 * probe found a clonable repository (and `ref`, when given, is checked out-able). Pure. */
export function repositoryProblem(
  probe: GitRemoteProbe,
  repoUrl: string,
  ref: string | undefined,
  hasCredential: boolean,
): string | null {
  switch (probe.kind) {
    case "reachable":
      if (ref !== undefined && !refIsAdvertised(probe.refs, ref)) {
        return `${repoUrl} has no branch or tag named '${ref}'.`;
      }
      return null;
    case "unavailable":
      return hasCredential
        ? `${repoUrl} was not found, or your connected Git account cannot read it. Check the URL and the repository's access.`
        : `${repoUrl} was not found, or it is private. Check the URL, or connect your Git account to use a private repository.`;
    case "unreachable":
      return `${repoUrl} could not be reached: ${probe.detail}`;
  }
}

/**
 * Ask the host for the repository's ref advertisement, as `git clone` does first. The
 * credential (when present) goes as HTTP Basic auth exactly like git's credential
 * helper supplies it, so the answer matches what the workspace will get at boot.
 * Network/protocol failures become an `unreachable` probe — this never throws.
 */
export async function probeGitRemote(
  repoUrl: string,
  credential: GitCredential | null,
  fetchImpl: typeof fetch = fetch,
): Promise<GitRemoteProbe> {
  const headers: Record<string, string> = { Accept: "*/*" };
  if (credential !== null) {
    const basic = Buffer.from(`${credential.username}:${credential.token}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }
  let res: Response;
  try {
    res = await fetchImpl(refAdvertisementUrl(repoUrl), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(GIT_REMOTE_PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (UNAVAILABLE_STATUSES.has(res.status)) return { kind: "unavailable", status: res.status };
  if (!res.ok) {
    return { kind: "unreachable", detail: `the host answered HTTP ${res.status.toString()}` };
  }
  // A 200 that is not a ref advertisement is a web page (a host serving HTML for an
  // unknown path, a login wall) — the repository is not clonable from this URL.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith(ADVERTISEMENT_CONTENT_TYPE)) {
    return {
      kind: "unreachable",
      detail: `the host did not answer as a git repository (${contentType || "no content type"})`,
    };
  }
  return { kind: "reachable", refs: parseRefAdvertisement(await res.text()) };
}
