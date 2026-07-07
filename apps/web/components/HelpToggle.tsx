// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { findHelp } from "../lib/help-content";
import { TESTID } from "../lib/testids";

/**
 * A toggleable help overlay rendered from the topbar. Shows a circled-i (ⓘ) icon
 * on every page. Clicking it opens a page-specific help dialog over the page.
 * Default: closed. The help content is different per route (see help-content.tsx).
 */
export function HelpToggle() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const content = findHelp(pathname);

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
        <div
          className="help-overlay"
          role="presentation"
          onClick={() => {
            setOpen(false);
          }}
        >
          <section
            id="help-panel"
            className="help-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Help for this page"
            data-testid={TESTID.helpPanel}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              className="help-panel-close"
              aria-label="Close help"
              data-testid={TESTID.helpPanelClose}
              onClick={() => {
                setOpen(false);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
            <div className="help-panel-inner">{content}</div>
          </section>
        </div>
      )}
    </>
  );
}
