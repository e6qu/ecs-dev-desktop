// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

import { sshKeyFingerprint, type SshKeyFingerprint, type SshPublicKey } from "./ids";

/** Charset shared by the workspace SSH principal and the per-workspace
 * subdomain label so the two stay in lockstep (mirrors `WORKSPACE_LABEL_RE` in
 * proxy-authz.ts — a `ws-<uuid>` id is 39 chars, the regex max). */
const WORKSPACE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** Whether a workspace id is a valid DNS/SSH label (so callers can decide
 * before building a principal/host that would otherwise throw). */
export function isWorkspaceLabel(value: string): boolean {
  return WORKSPACE_LABEL_RE.test(value);
}

/**
 * SSH principal a workspace container runs as. The gateway authenticates the
 * human identity by their registered public key (its `AuthorizedKeysCommand`
 * asks the control plane's `ssh-authorize` whether the presented key belongs to
 * the workspace owner), then connects as this system user.
 */
export function workspacePrincipal(workspaceId: string): string {
  if (!isWorkspaceLabel(workspaceId)) {
    throw new Error(`invalid workspaceId for SSH principal: ${workspaceId}`);
  }
  return `dev-${workspaceId}`;
}

/**
 * The per-workspace SSH hostname under the SSH subdomain zone:
 * `<workspaceId>.<baseDomain>` (e.g. `ws-abc123.ssh.example.com`). Each running
 * workspace is reachable at its own subdomain; the gateway behind the wildcard
 * resolves the workspace from this label. The label is a single valid DNS label
 * (see {@link isWorkspaceLabel}), the same charset the in-app HTTP proxy path
 * segment (`/w/<id>/`) accepts, so SSH host and HTTP path stay in lockstep.
 */
export function workspaceSshHost(workspaceId: string, baseDomain: string): string {
  if (!isWorkspaceLabel(workspaceId)) {
    throw new Error(`invalid workspaceId for SSH host: ${workspaceId}`);
  }
  if (baseDomain.trim().length === 0) {
    throw new Error("baseDomain is required for the workspace SSH host");
  }
  return `${workspaceId}.${baseDomain}`;
}

/** The key-type field of an OpenSSH public-key line (e.g. `ssh-ed25519`). */
export function sshKeyType(publicKey: SshPublicKey | string): string {
  const type = publicKey.trim().split(/\s+/)[0];
  if (type === undefined || type.length === 0) {
    throw new Error("ssh public key has no type field");
  }
  return type;
}

/**
 * OpenSSH SHA256 fingerprint of a public key (`SHA256:<base64-no-pad>`) — the
 * stable identity a registered key is deduped and looked up by, computed over
 * the base64-decoded key blob exactly as `ssh-keygen -lf` does. Throws loudly on
 * a key with no parseable blob rather than fingerprinting garbage.
 */
export function fingerprintPublicKey(publicKey: SshPublicKey | string): SshKeyFingerprint {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (blob === undefined || blob.length === 0) {
    throw new Error("ssh public key has no key material to fingerprint");
  }
  const raw = Buffer.from(blob, "base64");
  if (raw.length === 0) {
    throw new Error("ssh public key blob did not decode to any bytes");
  }
  const digest = createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
  return sshKeyFingerprint(`SHA256:${digest}`);
}
