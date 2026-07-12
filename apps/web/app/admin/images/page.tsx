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
            Container image sizes with per-layer breakdown, the golden-image source-sync state, and
            build history from <strong>both</strong> builders — GitHub Actions (webhook-driven on
            push) and AWS CodeBuild (e.g. the terraform-apply bootstrap). This console observes
            builds; it does not start them.
          </p>
        </div>
      </div>
      <ImagesConsole />
    </>
  );
}
