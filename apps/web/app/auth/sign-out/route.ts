// SPDX-License-Identifier: AGPL-3.0-or-later
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { performSignOut } from "../../../lib/sign-out";

// POST /auth/sign-out — the sign-out endpoint a plain HTML form submits as a
// DOCUMENT request. The 303 it answers is a real browser redirect, so the
// cross-origin hop into Shauth's end-session endpoint needs no CORS, no RSC
// and no hydration; see lib/sign-out for why a server action cannot do this.
export async function POST(request: Request): Promise<NextResponse> {
  const { redirectTo } = await performSignOut(await cookies());
  return NextResponse.redirect(new URL(redirectTo, request.url), 303);
}
