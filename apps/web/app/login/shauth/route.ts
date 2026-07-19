// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

import { signIn } from "../../../auth";
import { shauthEnabled } from "../../../lib/shauth";

/** Start Shauth from a route handler so Auth.js may set its OAuth cookies. */
export async function GET(): Promise<never> {
  if (!shauthEnabled()) redirect("/login?error=Configuration");
  await signIn("shauth", { redirectTo: "/workspaces" });
  throw new Error("Shauth sign-in did not redirect");
}
