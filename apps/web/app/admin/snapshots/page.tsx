// SPDX-License-Identifier: AGPL-3.0-or-later
import { SnapshotsConsole } from "../../../components/SnapshotsConsole";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). Lists managed EBS snapshots and lets an
// admin purge the unreferenced, retained orphans that accrue with no attribution.
export default function AdminSnapshotsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">storage</div>
          <h1>Snapshots</h1>
          <p>
            Every managed EBS snapshot with its workspace attribution, size, and age. Snapshots a
            live or stopped workspace still restores from are marked in&nbsp;use and protected;
            retained orphans with no owning workspace can be purged here to reclaim storage.
          </p>
        </div>
      </div>
      <SnapshotsConsole />
    </>
  );
}
