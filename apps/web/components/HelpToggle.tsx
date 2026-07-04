// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { findHelp } from "../lib/help-content";
import { TESTID } from "../lib/testids";

/**
 * A toggleable help panel rendered in the topbar. Shows a circled-i (ⓘ) icon on
 * every page. Clicking it opens a page-specific help section below the toolbar.
 * Default: closed. The help content is different per route (see help-content.tsx).
 */
export function HelpToggle() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const content = findHelp(pathname);

  if (content === null) return null;

  return (
    <>
      <button
        type="button"
        className="help-toggle"
        aria-label={open ? "Close help" : "Open help for this page"}
        aria-expanded={open}
        data-testid={TESTID.helpToggle}
        data-help-open={open ? "1" : "0"}
        onClick={() => {
          setOpen((v) => !v);
        }}
        title="Help for this page"
      >
        ⓘ
      </button>
      {open && (
        <div className="help-panel" data-testid={TESTID.helpPanel}>
          <div className="help-panel-inner">{content}</div>
        </div>
      )}
    </>
  );
}
