// SPDX-License-Identifier: AGPL-3.0-or-later
import { SSH_BASE_DOMAIN } from "@edd/config";

import { GitSshKeys } from "../../../components/GitSshKeys";
import { SshKeys } from "../../../components/SshKeys";
import { gitIntegration } from "../../../lib/git-integration";
import { StateBlock } from "../../../components/StateBlock";
import { getPagePrincipal } from "../../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * Account settings — SSH keys. Register the public keys you'll use to SSH into
 * your workspaces. Each running workspace is reachable at its own subdomain; the
 * gateway authenticates you by a registered key and authorizes the workspace by
 * ownership.
 */
export default async function SshKeysPage() {
  const principal = await getPagePrincipal();
  if (principal === null) {
    return (
      <StateBlock
        title="Not signed in"
        detail="Sign in to manage your SSH keys."
        action={{ href: "/login", label: "sign in" }}
      />
    );
  }

  const git = gitIntegration();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">account</div>
          <h1>SSH keys</h1>
          <p>
            Register a public key to SSH into your workspaces. Only the public key is sent — your
            private key never leaves your machine.
            {SSH_BASE_DOMAIN !== "" && (
              <>
                {" "}
                Connect with{" "}
                <code className="mono">
                  ssh dev-&lt;workspace-id&gt;@&lt;workspace-id&gt;.{SSH_BASE_DOMAIN}
                </code>
                ; each workspace shows its exact command on the workspaces page.
              </>
            )}
          </p>
        </div>
      </div>
      <SshKeys />

      <div className="page-head" style={{ marginTop: 40 }}>
        <div>
          <div className="kicker">git access</div>
          <h2>GitHub SSH keys</h2>
          <p>
            Keys the platform generates and holds for you, so your workspaces can clone and push
            private repositories over SSH. You add the public half to {git.host}; the private half
            never leaves the platform.
          </p>
        </div>
      </div>
      <GitSshKeys host={git.host} enabled={git.sshKeys} />
    </>
  );
}
