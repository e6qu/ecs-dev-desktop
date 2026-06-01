// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { health } from "../../../lib/health";

export function GET() {
  return NextResponse.json(health());
}
