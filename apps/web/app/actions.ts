// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";
import { effectiveRole } from "@edd/authz";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PERSONA_COOKIE } from "../lib/constants";
import { encodePersonaCookie, getPagePrincipal } from "../lib/principal";

// Host-only (no Domain), matching the dev-auth cookie convention.
const PERSONA_COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/" } as const;

/**
 * Set (or clear) the caller's "view as" persona override. Always re-derives the
 * real role from the live session/dev-auth (never trusts a client-supplied real
 * role) and clamps the requested persona against it — downgrade-only, so a developer
 * can never grant themselves admin by posting a crafted form value. Clears the
 * cookie entirely when the requested persona resolves back to the real role, so
 * "no override" stays the common, cookie-free case. The stored value carries the
 * cookie schema version (§6.5a) — readers ignore any other shape.
 */
export async function setPersonaAction(formData: FormData): Promise<void> {
  const principal = await getPagePrincipal();
  if (principal === null) return;
  const realRole = principal.realRole ?? principal.role;
  const requested = formData.get("persona");
  const clamped = effectiveRole(realRole, typeof requested === "string" ? requested : undefined);

  const store = await cookies();
  if (clamped === realRole) {
    store.delete(PERSONA_COOKIE);
  } else {
    store.set(PERSONA_COOKIE, encodePersonaCookie(clamped), PERSONA_COOKIE_OPTS);
  }
  revalidatePath("/", "layout");
}

/**
 * The escape hatch next to the persona switcher: delete EVERY cookie this app can
 * see (persona override, dev-auth, Auth.js session/CSRF — whatever the browser
 * sent) and land on /login. All the app's cookie readers already fail soft on a
 * missing/stale cookie, so this can never make things worse — it just guarantees
 * a clean slate without the user digging through browser settings.
 */
export async function resetCookiesAction(): Promise<void> {
  const store = await cookies();
  for (const cookie of store.getAll()) {
    store.delete(cookie.name);
  }
  redirect("/login");
}
