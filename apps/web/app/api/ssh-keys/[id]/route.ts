// SPDX-License-Identifier: AGPL-3.0-or-later
import { sshKeyId } from "@edd/core";

import { deleteOwned, type IdRouteContext } from "../../../../lib/api";
import { getSshKeyService } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// DELETE /api/ssh-keys/:id — remove one of the caller's registered keys.
// Ownership-scoped: a caller can only delete their own keys (404 otherwise).
const handleDELETE = (req: Request, { params }: IdRouteContext) =>
  deleteOwned(req, params, (principal, id) =>
    getSshKeyService().remove(principal.id, sshKeyId(id)),
  );

export const DELETE = withObservability("sshKeys.delete", handleDELETE);
