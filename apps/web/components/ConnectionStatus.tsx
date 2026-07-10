// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { TESTID } from "../lib/testids";

const HEALTH_PROBE_INTERVAL_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const FAILURES_BEFORE_DISCONNECTED = 2;

/**
 * Detects a genuinely disconnected control-plane browser session. Normal state
 * convergence stays automatic through each live view's refresh stream/poll; this
 * control appears only when even the control-plane health probe cannot complete.
 */
export function ConnectionStatus() {
  const router = useRouter();
  const failures = useRef(0);
  const [disconnected, setDisconnected] = useState(false);

  const probe = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/healthz", {
        cache: "no-store",
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(`control-plane health returned HTTP ${String(response.status)}`);
      const recovered = failures.current > 0 || disconnected;
      failures.current = 0;
      setDisconnected(false);
      if (recovered) router.refresh();
    } catch {
      failures.current += 1;
      if (failures.current >= FAILURES_BEFORE_DISCONNECTED) setDisconnected(true);
    }
  }, [disconnected, router]);

  useEffect(() => {
    const offline = (): void => {
      failures.current = FAILURES_BEFORE_DISCONNECTED;
      setDisconnected(true);
    };
    const online = (): void => {
      void probe();
    };
    const handle = window.setInterval(() => void probe(), HEALTH_PROBE_INTERVAL_MS);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (!navigator.onLine) offline();
    return () => {
      window.clearInterval(handle);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [probe]);

  if (!disconnected) return null;
  return (
    <button
      className="btn connection-refresh"
      data-testid={TESTID.connectionRefresh}
      type="button"
      onClick={() => {
        window.location.reload();
      }}
      title="Reload after the connection to the control plane was lost"
    >
      connection lost · refresh
    </button>
  );
}
