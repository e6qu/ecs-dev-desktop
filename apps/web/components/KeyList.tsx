// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { ReactNode } from "react";

import { StateBlock } from "./StateBlock";

/** The three states of a per-account key list: loading, empty (with direction), rows. */
export function KeyList<T extends { id: string }>({
  keys,
  emptyTitle,
  emptyDetail,
  renderRow,
}: {
  keys: readonly T[] | null;
  emptyTitle: string;
  emptyDetail: string;
  renderRow: (key: T) => ReactNode;
}) {
  if (keys === null) {
    return (
      <p className="state-note" role="status">
        loading…
      </p>
    );
  }
  if (keys.length === 0) return <StateBlock title={emptyTitle} detail={emptyDetail} />;
  return <ul className="list">{keys.map(renderRow)}</ul>;
}

/** An inline failure notice announced to assistive tech. */
export function ErrorNotice({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="mono" style={{ color: "var(--st-error)" }}>
      {error}
    </p>
  );
}

/** A key's human label over its type and fingerprint, as every key row leads with. */
export function KeyIdentity({
  label,
  keyType,
  fingerprint,
}: {
  label: string;
  keyType: string;
  fingerprint: string;
}) {
  return (
    <>
      <span>{label}</span>
      <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
        {keyType} · {fingerprint}
      </span>
    </>
  );
}
