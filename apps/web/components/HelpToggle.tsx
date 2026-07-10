// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";

import { findHelp } from "../lib/help-content";
import { TESTID } from "../lib/testids";
import { Modal } from "./Modal";

/**
 * A toggleable help overlay rendered from the topbar. Shows a circled-i (ⓘ) icon
 * on every page. Clicking it opens a page-specific help dialog over the page.
 * Default: closed. The help content is different per route (see help-content.tsx).
 */
export function HelpToggle() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const content = findHelp(pathname);
  const modalId = "page-help";

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  if (content === null) return null;

  return (
    <>
      <button
        type="button"
        className="help-toggle"
        aria-label={open ? "Close help" : "Open help for this page"}
        aria-expanded={open}
        aria-controls="help-panel"
        data-testid={TESTID.helpToggle}
        data-help-open={open ? "1" : "0"}
        onClick={toggle}
        title="Help for this page"
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <Modal
          modalId={modalId}
          panelId="help-panel"
          ariaLabel="Help for this page"
          testId={TESTID.helpPanel}
          onClose={close}
        >
          <button
            type="button"
            className="help-panel-close"
            aria-label="Close help"
            data-testid={TESTID.helpPanelClose}
            onClick={close}
          >
            <span aria-hidden="true">×</span>
          </button>
          <div className="help-panel-inner">{content}</div>
        </Modal>
      )}
    </>
  );
}
