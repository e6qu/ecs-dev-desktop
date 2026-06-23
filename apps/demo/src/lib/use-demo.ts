// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";

import { DemoControlPlane } from "./demo-control-plane";

/** The single browser-wide control plane (seeds localStorage on first construction). */
export const demo = new DemoControlPlane();

/** Subscribe a component to demo-state changes; returns the control plane for reads + actions. */
export function useDemo(): DemoControlPlane {
  useSyncExternalStore(
    (cb) => demo.subscribe(cb),
    () => demo.getVersion(),
  );
  return demo;
}
