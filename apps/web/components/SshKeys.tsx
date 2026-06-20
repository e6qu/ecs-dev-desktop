// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient, ApiError } from "@edd/api-client";
import type { SshKeyDto } from "@edd/api-contracts";
import { useEffect, useState } from "react";

import { TESTID } from "../lib/testids";
import { StateBlock } from "./StateBlock";

const api = new ApiClient({ baseUrl: "" });

/**
 * Account SSH keys: register the public keys you'll use to SSH into your
 * workspaces, and remove ones you no longer use. Only the public key is sent —
 * the private key never leaves your machine. A given public key can belong to one
 * account, so registering a key already on file is rejected.
 */
export function SshKeys() {
  const [keys, setKeys] = useState<SshKeyDto[] | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Removing a key is destructive (you lose SSH access from that key), so it takes a
  // second click to confirm. Keyed by key-id — arming one row must not arm the others.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setKeys(await api.listSshKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load SSH keys");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const trimmedLabel = label.trim();
      await api.registerSshKey({
        publicKey: publicKey.trim(),
        ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
      });
      setPublicKey("");
      setLabel("");
      await refresh();
    } catch (e) {
      // Surfaces the real reason (e.g. "already registered to another account").
      setError(e instanceof ApiError ? e.message : "could not register the key");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSshKey(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not remove the key");
    } finally {
      setBusy(false);
      setConfirmingId(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="stack" style={{ gap: 10 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          add a key
        </div>
        <textarea
          className="input"
          rows={3}
          placeholder="ssh-ed25519 AAAA… you@machine"
          data-testid={TESTID.sshKeyInput}
          value={publicKey}
          onChange={(e) => {
            setPublicKey(e.target.value);
          }}
        />
        <input
          className="input"
          placeholder="label (optional, e.g. laptop)"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn primary"
          data-testid={TESTID.sshKeyAdd}
          disabled={busy || publicKey.trim().length === 0}
          onClick={() => void add()}
        >
          register key
        </button>
        {error !== null && (
          <p className="mono" style={{ color: "var(--st-error)" }}>
            {error}
          </p>
        )}
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          your keys
        </div>
        {keys === null ? (
          <p className="state-note">loading…</p>
        ) : keys.length === 0 ? (
          <StateBlock
            title="No SSH keys yet"
            detail="Add a public key above to SSH into your workspaces."
          />
        ) : (
          <ul className="list">
            {keys.map((k) => (
              <li
                key={k.id}
                className="row"
                data-testid={TESTID.sshKeyRow}
                data-fingerprint={k.fingerprint}
              >
                <span className="stack" style={{ gap: 2 }}>
                  <span>{k.label}</span>
                  <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
                    {k.keyType} · {k.fingerprint}
                  </span>
                </span>
                <span className="foot">
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    aria-label={
                      confirmingId === k.id ? "confirm delete — removes this SSH key" : "remove"
                    }
                    onClick={() => {
                      if (confirmingId !== k.id) {
                        setConfirmingId(k.id);
                        return;
                      }
                      void remove(k.id);
                    }}
                  >
                    {confirmingId === k.id ? "confirm delete?" : "remove"}
                  </button>
                  {confirmingId === k.id && !busy && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setConfirmingId(null);
                      }}
                    >
                      cancel
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
