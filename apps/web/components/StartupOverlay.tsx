// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";

/** How long the startup overlay holds before fading out. */
const HOLD_MS = 1400;
const FADE_MS = 300;

/**
 * A brief full-screen "loading" overlay shown on the initial app load (a full-page
 * load / hard refresh), then faded out. It lives in the root layout, which is NOT
 * remounted on client-side navigations, so it naturally appears only on the first
 * visit / reload — not when moving between portal pages. Purely cosmetic: it covers
 * the first paint/hydration flash and gives the app a deliberate "starting up" feel.
 */
export function StartupOverlay() {
  // Two-phase: `visible` mounts the overlay; `leaving` triggers the fade before unmount.
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t1 = window.setTimeout(() => {
      setLeaving(true);
    }, HOLD_MS);
    const t2 = window.setTimeout(() => {
      setVisible(false);
    }, HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      data-testid="startup-overlay"
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        background: "var(--bg, #0d0f0c)",
        opacity: leaving ? 0 : 1,
        transition: `opacity ${String(FADE_MS)}ms ease`,
        pointerEvents: leaving ? "none" : "auto",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: "3px solid var(--line, #2a2f27)",
          borderTopColor: "var(--accent, #9fef00)",
          animation: "edd-spin 0.8s linear infinite",
        }}
      />
      <div className="mono" style={{ color: "var(--dim)", fontSize: 13, letterSpacing: 1 }}>
        loading EDD…
      </div>
      <style>{`@keyframes edd-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
