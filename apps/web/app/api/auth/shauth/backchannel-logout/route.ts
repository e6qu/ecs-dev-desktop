// SPDX-License-Identifier: AGPL-3.0-or-later
import { consumeProviderLogoutToken } from "../../../../../lib/auth-sessions";
import { shauthOidcConfig, verifyShauthBackchannelLogoutToken } from "../../../../../lib/shauth";

const MAX_LOGOUT_REQUEST_BYTES = 16 * 1024;

class LogoutRequestTooLargeError extends Error {}

async function boundedRequestText(request: Request): Promise<string> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_LOGOUT_REQUEST_BYTES) {
        await reader.cancel();
        throw new LogoutRequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

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
  let body: string;
  try {
    body = await boundedRequestText(request);
  } catch (error) {
    if (error instanceof LogoutRequestTooLargeError) {
      return new Response("Request is too large", { status: 413 });
    }
    return new Response("Invalid request body", { status: 400 });
  }
  const params = new URLSearchParams(body);
  const logoutTokens = params.getAll("logout_token");
  if (logoutTokens.length !== 1 || logoutTokens[0].length === 0) {
    return new Response("A single logout_token is required", { status: 400 });
  }

  try {
    const token = await verifyShauthBackchannelLogoutToken(logoutTokens[0], config);
    await consumeProviderLogoutToken("shauth", token);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.warn("Rejected Shauth back-channel logout token", error);
    return new Response("Invalid logout token", { status: 400 });
  }
}
