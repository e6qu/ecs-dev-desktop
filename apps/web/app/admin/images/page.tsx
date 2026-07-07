// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImagesConsole } from "../../../components/ImagesConsole";

export const dynamic = "force-dynamic";

export default function AdminImagesPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">platform</div>
          <h1>Images &amp; builds</h1>
          <p>
            Container image sizes and per-layer breakdown, plus build history and live logs.
            Trigger a fast control-plane rebuild (<span className="mono">web</span>) or a golden
            workspace-image rebuild (<span className="mono">golden</span>) without a full deploy.
          </p>
        </div>
      </div>
      <ImagesConsole />
    </>
  );
}
