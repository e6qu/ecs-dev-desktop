// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient, ApiError } from "@edd/api-client";
import type { GitSshKeyDto } from "@edd/api-contracts";
import { useEffect, useState } from "react";

import { TESTID } from "../lib/testids";
import { ConfirmRemove } from "./ConfirmRemove";
import { ErrorNotice, KeyIdentity, KeyList } from "./KeyList";
import { StateBlock } from "./StateBlock";

const api = new ApiClient({ baseUrl: "" });

/** How long the "copied" confirmation stays on a row after copying its public key. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * GitHub SSH keys: keys the platform generates and holds for you, so every one of your
 * workspaces can clone and push over SSH. You copy the public half into GitHub (an account
 * key, or a repository's deploy key); the private half never leaves the platform — it is
 * delivered into your running workspaces only.
 */
export function GitSshKeys({ host, enabled }: { host: string; enabled: boolean }) {
  const [keys, setKeys] = useState<GitSshKeyDto[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setKeys(await api.listGitSshKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load GitHub SSH keys");
    }
  }

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled]);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.generateGitSshKey({ label: label.trim() });
      setLabel("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "could not generate the key");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.deleteGitSshKey(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not remove the key");
    } finally {
      setBusy(false);
      setConfirmingId(null);
    }
  }

  async function copy(key: GitSshKeyDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      setCopiedId(key.id);
      setTimeout(() => {
        setCopiedId((current) => (current === key.id ? null : current));
      }, COPIED_FEEDBACK_MS);
    } catch {
      setError("could not copy — select the key text and copy it by hand");
    }
  }

  if (!enabled) {
    return (
      <StateBlock
        title="GitHub SSH keys are not enabled here"
        detail="This deployment has no EDD_TOKEN_ENC_KEY, which protects generated private keys at rest. Ask an admin to configure it."
      />
    );
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="stack" style={{ gap: 10 }}>
        <h2 className="mono section-h">generate a key</h2>
        <p className="state-note" style={{ margin: 0 }}>
          The platform makes an ed25519 key and keeps its private half for your workspaces. Add the
          public half to {host} as an account SSH key, or as a deploy key on one repository, then
          clone with an SSH URL (<code className="mono">git@{host}:…</code>).
        </p>
        <label className="mono stack" style={{ fontSize: 12, gap: 6 }}>
          Name
          <input
            className="input"
            placeholder="e.g. work laptop, or the repository it is a deploy key for"
            aria-label="Name for the new GitHub SSH key"
            data-testid={TESTID.gitSshKeyLabel}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn primary"
          data-testid={TESTID.gitSshKeyGenerate}
          disabled={busy || label.trim().length === 0}
          onClick={() => void generate()}
        >
          generate key
        </button>
        <ErrorNotice error={error} />
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="mono section-h">your GitHub keys</h2>
        <KeyList
          keys={keys}
          emptyTitle="No GitHub SSH keys yet"
          emptyDetail="Generate one above, then add its public key to GitHub."
          renderRow={(k) => (
            <li
              key={k.id}
              className="row"
              data-testid={TESTID.gitSshKeyRow}
              data-fingerprint={k.fingerprint}
              style={{ alignItems: "flex-start" }}
            >
              <span className="stack" style={{ gap: 6, minWidth: 0, flex: 1 }}>
                <KeyIdentity label={k.label} keyType={k.keyType} fingerprint={k.fingerprint} />
                <code
                  className="mono"
                  data-testid={TESTID.gitSshKeyPublic}
                  style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all" }}
                >
                  {k.publicKey}
                </code>
              </span>
              <span className="foot">
                <button
                  type="button"
                  className="btn"
                  aria-label={`copy the public key for ${k.label}`}
                  onClick={() => void copy(k)}
                >
                  {copiedId === k.id ? "copied" : "copy public key"}
                </button>
                <ConfirmRemove
                  id={k.id}
                  confirmingId={confirmingId}
                  setConfirmingId={setConfirmingId}
                  busy={busy}
                  armLabel={`remove the key ${k.label}`}
                  confirmLabel={`confirm delete — removes the key ${k.label}`}
                  onConfirm={(id) => void remove(id)}
                />
              </span>
            </li>
          )}
        />
      </section>
    </div>
  );
}
