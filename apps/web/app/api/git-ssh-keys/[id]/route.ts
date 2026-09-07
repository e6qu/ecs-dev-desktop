// SPDX-License-Identifier: AGPL-3.0-or-later
import { sshKeyId } from "@edd/core";

import { conflict, deleteOwned, type IdRouteContext } from "../../../../lib/api";
import { gitIntegration } from "../../../../lib/git-integration";
import { getGitSshKeys } from "../../../../lib/git-credentials";
import { withObservability } from "../../../../lib/observability";

// DELETE /api/git-ssh-keys/:id — remove one of the caller's generated keys. Ownership-scoped:
// a caller can only delete their own keys (404 otherwise). The host still holds the public
// half until the user removes it there; the private half is gone, so it can no longer be used.
const handleDELETE = (req: Request, { params }: IdRouteContext) =>
  deleteOwned(req, params, (principal, id) =>
    gitIntegration().sshKeys
      ? getGitSshKeys().remove(principal.id, sshKeyId(id))
      : Promise.resolve(
          conflict("git SSH keys are not enabled on this deployment (EDD_TOKEN_ENC_KEY is unset)"),
        ),
  );

export const DELETE = withObservability("gitSshKeys.delete", handleDELETE);
