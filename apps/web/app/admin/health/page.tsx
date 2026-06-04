// SPDX-License-Identifier: AGPL-3.0-or-later
import { HealthBoard } from "../../../components/HealthBoard";

export const dynamic = "force-dynamic";

export default function AdminHealthPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">troubleshooting</div>
          <h1>System health</h1>
          <p>
            Live status of the control plane and its dependencies. Provider, reconciler, and
            container checks light up on AWS (CloudWatch/CloudTrail).
          </p>
        </div>
      </div>
      <HealthBoard />
    </>
  );
}
