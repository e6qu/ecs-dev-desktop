// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

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

/** What a Tab press can land on inside the dialog (the trap's stops). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Shared modal shell: body portal, backdrop close, Escape close, focus
 * management (focus moves into the dialog on open, Tab is trapped inside it,
 * and focus returns to the trigger on close), and the one-active-modal
 * coordination contract used by every circle-i dialog. */
export function Modal({
  modalId,
  ariaLabel,
  panelId,
  panelClassName,
  testId,
  onClose,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  // Focus: move into the dialog on open; restore to the opener on close, so
  // keyboard/screen-reader users are never left focused behind the overlay.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    const onModalOpen = (event: Event): void => {
      if (!(event instanceof CustomEvent) || event.detail !== modalId) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Trap Tab within the dialog (aria-modal promises focus cannot leave it):
      // wrap from the last focusable back to the first and vice versa, and pull
      // focus back in if it somehow ended up outside.
      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      const inside = current !== null && panel.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first || current === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
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
          ref={panelRef}
          tabIndex={-1}
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
