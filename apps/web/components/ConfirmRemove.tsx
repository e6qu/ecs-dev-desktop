// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

/**
 * A destructive "remove" that takes a second click to confirm, with a cancel while armed.
 * The parent owns which row is armed (`confirming`), so arming one row never arms another.
 */
export function ConfirmRemove({
  id,
  confirmingId,
  setConfirmingId,
  busy,
  armLabel,
  confirmLabel,
  onConfirm,
}: {
  /** This row's id. */
  id: string;
  /** Which row is armed (the parent's state), or null. */
  confirmingId: string | null;
  setConfirmingId: (id: string | null) => void;
  busy: boolean;
  /** Accessible name while disarmed (the visible text is always "remove"). */
  armLabel: string;
  /** Accessible name while armed (the visible text is always "confirm delete?"). */
  confirmLabel: string;
  onConfirm: (id: string) => void;
}) {
  const confirming = confirmingId === id;
  return (
    <>
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        aria-label={confirming ? confirmLabel : armLabel}
        onClick={() => {
          if (confirming) onConfirm(id);
          else setConfirmingId(id);
        }}
      >
        {confirming ? "confirm delete?" : "remove"}
      </button>
      {confirming && !busy && (
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
    </>
  );
}
