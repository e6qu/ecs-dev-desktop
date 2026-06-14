// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createBaseImageRequest } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { baseImage } from "@edd/core";

import {
  authenticate,
  badRequest,
  conflict,
  errorMessage,
  forbidden,
  isResponse,
} from "../../../lib/api";
import { getCatalog } from "../../../lib/control-plane";
import { withObservability } from "../../../lib/observability";

// GET /api/base-images — list the catalog (any authenticated user can browse it).
async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("read", "BaseImage")) return forbidden();
  return NextResponse.json({ baseImages: await getCatalog().list() });
}

// POST /api/base-images — add a catalog entry (admins only).
async function handlePOST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("create", "BaseImage")) return forbidden();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = createBaseImageRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  try {
    const entry = await getCatalog().create({
      name: parsed.data.name,
      image: baseImage(parsed.data.image),
      description: parsed.data.description,
      enabled: parsed.data.enabled,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    return conflict(errorMessage(err));
  }
}

export const GET = withObservability("baseImages.list", handleGET);
export const POST = withObservability("baseImages.create", handlePOST);
