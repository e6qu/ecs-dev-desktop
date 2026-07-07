// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { updateBaseImageRequest } from "@edd/api-contracts";
import { defineAbilityFor, type Action } from "@edd/authz";
import { baseImage, baseImageId } from "@edd/core";

import {
  authenticate,
  badRequest,
  domainErrorResponse,
  forbidden,
  isResponse,
  notFound,
} from "../../../../lib/api";
import { getCatalog } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Authenticate + check `action` on BaseImage. Returns the principal or a Response. */
async function authorize(req: Request, action: Action): Promise<NextResponse | null> {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can(action, "BaseImage")) return forbidden();
  return null;
}

// GET /api/base-images/:id — read a single catalog entry.
async function handleGET(req: Request, { params }: Ctx) {
  const denied = await authorize(req, "read");
  if (denied) return denied;
  const entry = await getCatalog().get(baseImageId((await params).id));
  return entry === null ? notFound() : NextResponse.json(entry);
}

// PATCH /api/base-images/:id — update name/description/enabled (admins only).
async function handlePATCH(req: Request, { params }: Ctx) {
  const denied = await authorize(req, "update");
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = updateBaseImageRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  const { image, ...patch } = parsed.data;
  const result = await getCatalog().update(baseImageId((await params).id), {
    ...patch,
    ...(image === undefined ? {} : { image: baseImage(image) }),
  });
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

// DELETE /api/base-images/:id — remove a catalog entry (admins only).
async function handleDELETE(req: Request, { params }: Ctx) {
  const denied = await authorize(req, "delete");
  if (denied) return denied;
  const result = await getCatalog().remove(baseImageId((await params).id));
  return result.ok ? new NextResponse(null, { status: 204 }) : domainErrorResponse(result.error);
}

export const GET = withObservability("baseImages.get", handleGET);
export const PATCH = withObservability("baseImages.update", handlePATCH);
export const DELETE = withObservability("baseImages.delete", handleDELETE);
