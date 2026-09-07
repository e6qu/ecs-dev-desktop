// SPDX-License-Identifier: AGPL-3.0-or-later
import { GIT_REMOTE_PROBE_TIMEOUT_MS } from "@edd/config";
import { parseRefAdvertisement, type GitRemote, type GitRemoteProbe } from "@edd/core";
// ssh2 is CommonJS: a default import is the one shape that works under both the bundled
// (Next.js) and native-ESM (tsx) consumers.
import ssh2, { type ConnectConfig } from "ssh2";

/**
 * Create-time check that a session's repository can actually be cloned, done the way git
 * itself starts a clone: by asking the host for the repository's ref advertisement over
 * the transport the URL names —
 *
 * - `https://`: smart-HTTP `GET <repo>/info/refs?service=git-upload-pack`, with the
 *   owner's git token as HTTP Basic auth when one exists (exactly what git's credential
 *   helper supplies in the workspace);
 * - `ssh://`: an SSH session running `git-upload-pack '<path>'`, authenticated with the
 *   owner's platform-generated keys, tried in turn the way `ssh` walks `IdentityFile`s.
 *
 * Both are the one standard surface every git host exposes, so the same call works for
 * GitHub, GHES, or any host the URL names. Why this exists: a git host answers
 * "authentication required" for a repository that does not exist exactly as it does for
 * a private one, so without this check a typo'd URL sailed through create and only
 * failed minutes later inside the workspace with the opaque `could not read Username`.
 */

/** A git HTTPS credential (`username:token` for Basic auth), as the workspace helper sends it. */
export interface GitCredential {
  readonly username: string;
  readonly token: string;
}

/** One of the owner's SSH keys, private half in OpenSSH format, as the workspace gets it. */
export interface SshIdentity {
  readonly label: string;
  readonly privateKey: string;
}

const GIT_UPLOAD_PACK_SERVICE = "git-upload-pack";
const ADVERTISEMENT_CONTENT_TYPE = "application/x-git-upload-pack-advertisement";
/** HTTP statuses a git host uses for "you may not see this repository" (which for a
 * nonexistent repository is the same answer, so existence is not leaked). */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
const PKT_FLUSH = "0000";
const PKT_LINE_LENGTH_DIGITS = 4;

/** The `info/refs` URL for an https clone URL. */
export function refAdvertisementUrl(remote: GitRemote & { transport: "https" }): string {
  const url = new URL(remote.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/info/refs`;
  url.search = `service=${GIT_UPLOAD_PACK_SERVICE}`;
  return url.toString();
}

/** Ask the host over smart HTTP, as `git clone https://…` does first. Never throws. */
export async function probeGitRemoteOverHttps(
  remote: GitRemote & { transport: "https" },
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
    res = await fetchImpl(refAdvertisementUrl(remote), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(GIT_REMOTE_PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (UNAVAILABLE_STATUSES.has(res.status)) {
    return { kind: "unavailable", detail: `HTTP ${res.status.toString()}` };
  }
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

/** Whether `body` holds a complete advertisement: a flush packet at a pkt boundary. */
function advertisementComplete(body: string): boolean {
  let offset = 0;
  while (offset + PKT_LINE_LENGTH_DIGITS <= body.length) {
    const lengthHex = body.slice(offset, offset + PKT_LINE_LENGTH_DIGITS);
    if (lengthHex === PKT_FLUSH) return true;
    const length = Number.parseInt(lengthHex, 16);
    if (!Number.isInteger(length) || length < PKT_LINE_LENGTH_DIGITS) return false;
    offset += length;
  }
  return false;
}

/** The raw host-key blobs from OpenSSH `known_hosts` lines (`host type base64`). */
function knownHostKeyBlobs(knownHosts: readonly string[]): Buffer[] {
  const blobs: Buffer[] = [];
  for (const line of knownHosts) {
    const [, , blob = ""] = line.trim().split(/\s+/);
    if (blob.length > 0) blobs.push(Buffer.from(blob, "base64"));
  }
  return blobs;
}

type SshAttempt =
  | { readonly outcome: "refs"; readonly body: string }
  | { readonly outcome: "auth-rejected" }
  | { readonly outcome: "repo-rejected"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/** One SSH session with one key: connect, run git-upload-pack, read the advertisement. */
function sshAttempt(
  remote: GitRemote & { transport: "ssh" },
  identity: SshIdentity,
  hostKeys: readonly Buffer[],
): Promise<SshAttempt> {
  return new Promise((resolve) => {
    const client = new ssh2.Client();
    let settled = false;
    const finish = (attempt: SshAttempt): void => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(attempt);
    };
    const config: ConnectConfig = {
      host: remote.host,
      port: remote.port,
      username: remote.user,
      privateKey: identity.privateKey,
      readyTimeout: GIT_REMOTE_PROBE_TIMEOUT_MS,
      // Only the host keys the git host publishes are trusted when it publishes any; a
      // host that publishes none is accepted for this read-only advertisement (the
      // workspace records the same fact in its boot log).
      ...(hostKeys.length > 0
        ? { hostVerifier: (key: Buffer) => hostKeys.some((known) => known.equals(key)) }
        : {}),
    };
    client.on("error", (error: Error & { level?: string }) => {
      if (error.level === "client-authentication") {
        finish({ outcome: "auth-rejected" });
        return;
      }
      finish({ outcome: "failed", detail: error.message });
    });
    client.on("ready", () => {
      // The path is quoted for the remote shell the way git does it.
      client.exec(`git-upload-pack '${remote.path.replace(/'/g, "'\\''")}'`, (err, stream) => {
        if (err) {
          finish({ outcome: "failed", detail: err.message });
          return;
        }
        let body = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          // The server now waits for our "want"s; we have what we came for.
          if (advertisementComplete(body)) finish({ outcome: "refs", body });
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          if (advertisementComplete(body)) {
            finish({ outcome: "refs", body });
            return;
          }
          const detail = stderr.trim().length > 0 ? stderr.trim() : `exit ${String(code)}`;
          finish({ outcome: "repo-rejected", detail });
        });
      });
    });
    try {
      client.connect(config);
    } catch (e) {
      // ssh2 throws synchronously on key material it cannot parse.
      finish({ outcome: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Ask the host over SSH, as `git clone ssh://…` does, trying each identity in turn the way
 * `ssh` walks `IdentityFile`s. A deploy key is bound to one repository, so a key the host
 * accepts for authentication can still be refused for THIS repository — that also moves
 * on to the next key. Never throws.
 */
export async function probeGitRemoteOverSsh(
  remote: GitRemote & { transport: "ssh" },
  identities: readonly SshIdentity[],
  knownHosts: readonly string[],
): Promise<GitRemoteProbe> {
  if (identities.length === 0) {
    return { kind: "unavailable", detail: "you have no GitHub SSH keys yet" };
  }
  const hostKeys = knownHostKeyBlobs(knownHosts);
  const refusals: string[] = [];
  for (const identity of identities) {
    const attempt = await sshAttempt(remote, identity, hostKeys);
    switch (attempt.outcome) {
      case "refs":
        return { kind: "reachable", refs: parseRefAdvertisement(attempt.body) };
      case "auth-rejected":
        refusals.push(`'${identity.label}' was not accepted by ${remote.host}`);
        break;
      case "repo-rejected":
        refusals.push(`'${identity.label}': ${attempt.detail}`);
        break;
      case "failed":
        return { kind: "unreachable", detail: attempt.detail };
    }
  }
  return { kind: "unavailable", detail: refusals.join("; ") };
}
