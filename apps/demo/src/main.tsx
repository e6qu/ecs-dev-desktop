// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// Reuse the production design tokens + components' CSS (the demo's look = the real app's look),
// then layer the demo-shell layout on top.
import "../../web/app/globals.css";
import "./demo.css";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root element");
}
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
