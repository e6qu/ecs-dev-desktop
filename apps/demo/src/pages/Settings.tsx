// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";

import { relTime } from "../lib/format";
import { useDemo } from "../lib/use-demo";

export function Settings(): JSX.Element {
  const cp = useDemo();
  const keys = cp.sshKeys();
  const [publicKey, setPublicKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <section className="demo-page">
      <h2>Settings · SSH keys</h2>
      <p className="demo-fine">
        Register the public keys you’ll use to SSH into your workspaces. Only the public key is
        held; the key type is validated by the real <code>@edd/core</code> <code>sshKeyType</code>.
      </p>

      <form
        className="demo-ssh-add"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          try {
            cp.addSshKey(publicKey, label);
            setPublicKey("");
            setLabel("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "could not register the key");
          }
        }}
      >
        <textarea
          value={publicKey}
          onChange={(e) => {
            setPublicKey(e.target.value);
          }}
          placeholder="ssh-ed25519 AAAA… you@host"
          aria-label="Public key"
          rows={2}
        />
        <div className="demo-ssh-add-row">
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
            placeholder="label (optional)"
            aria-label="Label"
          />
          <button type="submit" className="demo-primary">
            Add key
          </button>
        </div>
      </form>
      {error !== null ? <p className="demo-error">{error}</p> : null}

      {keys.length === 0 ? (
        <p className="demo-empty">No SSH keys registered yet.</p>
      ) : (
        <ul className="adm-rows">
          {keys.map((k) => (
            <li key={k.id} className="adm-row">
              <div>
                <code>{k.label}</code>
                <div className="meta">
                  {k.keyType} · {k.publicKey.slice(0, 36)}… · added {relTime(k.addedAt)}
                </div>
              </div>
              {confirmingId === k.id ? (
                <button
                  type="button"
                  className="demo-danger"
                  onClick={() => {
                    cp.removeSshKey(k.id);
                    setConfirmingId(null);
                  }}
                >
                  confirm remove
                </button>
              ) : (
                <button
                  type="button"
                  className="demo-ghost"
                  onClick={() => {
                    setConfirmingId(k.id);
                  }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
