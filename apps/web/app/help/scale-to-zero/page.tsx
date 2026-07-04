// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { findHelp } from "../../../lib/help-content";

export default function ScaleToZeroHelpPage() {
  return (
    <div className="shell">
      <div className="page-head">
        <div>
          <div className="kicker">help</div>
          <h1>How auto-stop works</h1>
        </div>
        <Link href="/workspaces" className="btn">
          ← back to workspaces
        </Link>
      </div>
      <div className="help-panel-inner">{findHelp("/help/scale-to-zero")}</div>
    </div>
  );
}
