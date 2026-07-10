// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";

import { ModalPortal } from "./ModalPortal";

interface ModalProps {
  readonly modalId: string;
  readonly ariaLabel: string;
  readonly panelId?: string;
  readonly panelClassName?: string;
  readonly testId: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Shared modal shell: body portal, backdrop close, Escape close, and the
 * one-active-modal coordination contract used by every circle-i dialog. */
export function Modal({
  modalId,
  ariaLabel,
  panelId,
  panelClassName,
  testId,
  onClose,
  children,
}: ModalProps) {
  useEffect(() => {
    const onModalOpen = (event: Event): void => {
      if (!(event instanceof CustomEvent) || event.detail !== modalId) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("edd:modal-open", onModalOpen);
    window.addEventListener("keydown", onKey);
    window.dispatchEvent(new CustomEvent("edd:modal-open", { detail: modalId }));
    return () => {
      window.removeEventListener("edd:modal-open", onModalOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [modalId, onClose]);

  return (
    <ModalPortal>
      <div className="help-overlay" role="presentation" onClick={onClose}>
        <section
          id={panelId}
          className={`help-panel${panelClassName === undefined ? "" : ` ${panelClassName}`}`}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          data-testid={testId}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {children}
        </section>
      </div>
    </ModalPortal>
  );
}
