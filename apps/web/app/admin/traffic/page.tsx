// SPDX-License-Identifier: AGPL-3.0-or-later
import { TrafficFilterConsole } from "../../../components/TrafficFilterConsole";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). Configure traffic filtering (allow/block
// by IP CIDR, country, ASN, cloud/hoster preset, and a block-anonymous toggle) and
// apply it to the live CLOUDFRONT-scope WAFv2 Web ACL.
export default function AdminTrafficPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">security</div>
          <h1>Traffic filtering</h1>
          <p>
            Allow or block reaching the app by IP&nbsp;CIDR, country, ASN, and curated cloud/hoster
            presets, with a block-anonymous toggle for hosting/VPN/proxy/Tor sources. The compiled
            rules apply to the live CloudFront-scope WAF Web&nbsp;ACL. Preview the compiled rule set
            below before saving.
          </p>
        </div>
      </div>
      <TrafficFilterConsole />
    </>
  );
}
