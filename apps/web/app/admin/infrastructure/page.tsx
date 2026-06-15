// SPDX-License-Identifier: AGPL-3.0-or-later
import { InfrastructureView } from "../../../components/InfrastructureView";

export const dynamic = "force-dynamic";

export default function AdminInfrastructurePage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">operations</div>
          <h1>Infrastructure</h1>
          <p>
            The ECS cluster, dependency status checks, fleet metrics, and the component topology.
            Cluster counts and per-component status light up live (CloudWatch/ECS on AWS).
          </p>
        </div>
      </div>
      <InfrastructureView />
    </>
  );
}
