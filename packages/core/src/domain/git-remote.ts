// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure decisions about a session's git remote: what a clone URL points at, what a git
 * host's ref advertisement says, and how a failed probe is explained to the user. The
 * network calls that produce a {@link GitRemoteProbe} live in the shell (the web app's
 * `git-remote` module); everything here is data in, data out.
 */

/** Where a clone URL points, in the two transports a session can clone over. */
export type GitRemote =
  | {
      readonly transport: "https";
      /** The normalised clone URL (query/fragment dropped, no trailing slash). */
      readonly url: string;
      readonly host: string;
      /** `owner/repo` path with any `.git` suffix kept as given. */
      readonly path: string;
    }
  | {
      readonly transport: "ssh";
      /** Always the `ssh://user@host[:port]/path` form, whatever the user typed. */
      readonly url: string;
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly path: string;
    };

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SSH_USER = "git";
/** `git@github.com:owner/repo.git` — git's scp-like syntax (no scheme, a colon before the path). */
const SCP_LIKE_PATTERN = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(?!\/\/)([^\s]+)$/;

/**
 * Classify and normalise a clone URL the user typed. Accepts `https://…`, `ssh://…`, and
 * git's scp-like `user@host:path`; returns null for anything else (`http://`, `git://`, a
 * bare word, an empty path). Never throws.
 */
export function parseGitRemote(input: string): GitRemote | null {
  const text = input.trim();
  if (text.length === 0) return null;
  const scp = SCP_LIKE_PATTERN.exec(text);
  if (scp !== null && !text.includes("://")) {
    const user = scp[1] ?? DEFAULT_SSH_USER;
    const host = scp[2] ?? "";
    const cleaned = trimPath(scp[3] ?? "");
    if (host.length === 0 || cleaned === null) return null;
    return {
      transport: "ssh",
      url: `ssh://${user}@${host}/${cleaned}`,
      host,
      port: DEFAULT_SSH_PORT,
      user,
      path: cleaned,
    };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname.length === 0) return null;
  const path = trimPath(url.pathname);
  if (path === null) return null;
  if (url.protocol === "https:") {
    url.search = "";
    url.hash = "";
    url.pathname = `/${path}`;
    return { transport: "https", url: url.toString(), host: url.hostname, path };
  }
  if (url.protocol === "ssh:") {
    const user = url.username.length > 0 ? url.username : DEFAULT_SSH_USER;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : DEFAULT_SSH_PORT;
    if (!Number.isInteger(port) || port <= 0) return null;
    const portPart = port === DEFAULT_SSH_PORT ? "" : `:${port.toString()}`;
    return {
      transport: "ssh",
      url: `ssh://${user}@${url.hostname}${portPart}/${path}`,
      host: url.hostname,
      port,
      user,
      path,
    };
  }
  return null;
}

/** The path without surrounding slashes, or null when nothing is left. */
function trimPath(path: string): string | null {
  const cleaned = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * The `{ owner, name }` a repository path names — the owner picks a GitHub App
 * installation and `name` scopes a minted token to exactly that repository. Undefined
 * for a path without both segments. The `.git` suffix is stripped from the name.
 */
export function repoRef(
  remote: GitRemote | undefined,
): { owner: string; name: string } | undefined {
  if (remote === undefined) return undefined;
  const [owner, repo] = remote.path.split("/").filter((s) => s.length > 0);
  if (owner === undefined || repo === undefined) return undefined;
  const name = repo.replace(/\.git$/, "");
  if (name.length === 0) return undefined;
  return { owner, name };
}

/** The outcome of probing a remote for its ref advertisement. */
export type GitRemoteProbe =
  /** The host advertised the repository's refs (it exists and the credential offered can read it). */
  | { readonly kind: "reachable"; readonly refs: readonly string[] }
  /** The host refused or has no such repository: not found, or private and unreadable with
   * what was offered. Indistinguishable by design on GitHub. */
  | { readonly kind: "unavailable"; readonly detail: string }
  /** The host could not be reached or answered outside the protocol. */
  | { readonly kind: "unreachable"; readonly detail: string };

const PKT_LINE_LENGTH_DIGITS = 4;
const PKT_FLUSH = "0000";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Ref names from a git ref advertisement (pkt-line framed: an optional
 * `# service=…` banner, flushes, then `<sha> <ref>[\0caps]` per line — the shape both
 * smart-HTTP `info/refs` and `git-upload-pack` over SSH produce). A truncated or
 * malformed body yields the refs parsed so far; never throws. `HEAD` is included.
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
    const line = (payload.split("\0")[0] ?? "").replace(/\n$/, "");
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
 * only ref tips); a short SHA is treated as a name and must match a branch or tag.
 */
export function refIsAdvertised(refs: readonly string[], ref: string): boolean {
  if (FULL_SHA_PATTERN.test(ref)) return true;
  return refs.includes(`refs/heads/${ref}`) || refs.includes(`refs/tags/${ref}`);
}

/** What the create-time check offered the host, which decides how a refusal is explained. */
export type OfferedCredential = "none" | "token" | "ssh-keys";

/** The user-facing reason a session cannot be created from `repoUrl`, or null when the
 * probe found a clonable repository (and `ref`, when given, is checkout-able). */
export function repositoryProblem(
  probe: GitRemoteProbe,
  repoUrl: string,
  ref: string | undefined,
  offered: OfferedCredential,
): string | null {
  switch (probe.kind) {
    case "reachable":
      if (ref !== undefined && !refIsAdvertised(probe.refs, ref)) {
        return `${repoUrl} has no branch or tag named '${ref}'.`;
      }
      return null;
    case "unavailable":
      return unavailableProblem(repoUrl, probe.detail, offered);
    case "unreachable":
      return `${repoUrl} could not be reached: ${probe.detail}`;
  }
}

function unavailableProblem(repoUrl: string, detail: string, offered: OfferedCredential): string {
  switch (offered) {
    case "token":
      return `${repoUrl} was not found, or your connected Git account cannot read it. Check the URL and the repository's access.`;
    case "ssh-keys":
      return `${repoUrl} was not found, or none of your GitHub SSH keys can read it (${detail}). Check the URL, and that the key's public half is added to GitHub.`;
    case "none":
      return `${repoUrl} was not found, or it is private. Check the URL, or connect your Git account to use a private repository.`;
  }
}
