// SPDX-License-Identifier: AGPL-3.0-or-later
import { shauthLogoutCompletionURL, shauthOidcConfig } from "../../../../../lib/shauth";

export function GET(_request: Request): Response {
  const config = shauthOidcConfig();
  if (config === null) return new Response("Shauth is not configured", { status: 404 });
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: shauthLogoutCompletionURL(config),
    },
  });
}
