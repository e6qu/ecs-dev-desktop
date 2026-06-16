// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, isResponse, notFound } from "../../../../lib/api";
import { getSshKeyService } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// DELETE /api/ssh-keys/:id — remove one of the caller's registered keys.
// Ownership-scoped: a caller can only delete their own keys (404 otherwise).
async function handleDELETE(req: Request, { params }: Ctx) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  const { id } = await params;
  const removed = await getSshKeyService().remove(principal.id, id);
  if (!removed) return notFound();
  return NextResponse.json({ ok: true });
}

export const DELETE = withObservability("sshKeys.delete", handleDELETE);
