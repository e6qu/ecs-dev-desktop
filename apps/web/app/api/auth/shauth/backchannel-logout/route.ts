// SPDX-License-Identifier: AGPL-3.0-or-later
import { revokeAuthSessionsByProviderSession } from "../../../../../lib/auth-sessions";
import { shauthOidcConfig, verifyShauthBackchannelLogoutToken } from "../../../../../lib/shauth";

const MAX_LOGOUT_REQUEST_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  const config = shauthOidcConfig();
  if (config === null) return new Response("Shauth is not configured", { status: 503 });

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return new Response("Unsupported media type", { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGOUT_REQUEST_BYTES) {
    return new Response("Request is too large", { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_LOGOUT_REQUEST_BYTES) {
    return new Response("Request is too large", { status: 413 });
  }
  const params = new URLSearchParams(body);
  const logoutTokens = params.getAll("logout_token");
  if (logoutTokens.length !== 1 || logoutTokens[0].length === 0) {
    return new Response("A single logout_token is required", { status: 400 });
  }

  try {
    const sid = await verifyShauthBackchannelLogoutToken(logoutTokens[0], config);
    await revokeAuthSessionsByProviderSession("shauth", sid);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.warn("Rejected Shauth back-channel logout token", error);
    return new Response("Invalid logout token", { status: 400 });
  }
}
