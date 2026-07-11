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
            recent build trigger decisions. Builds are launched by GitHub Actions on push to the
            source repository — this console observes them; it cannot start one.
          </p>
        </div>
      </div>
      <ImagesConsole />
    </>
  );
}
