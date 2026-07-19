// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

import { signIn } from "../../../auth";
import { shauthEnabled } from "../../../lib/shauth";

export default async function ShauthLoginPage(): Promise<never> {
  if (!shauthEnabled()) redirect("/login?error=Configuration");
  await signIn("shauth", { redirectTo: "/workspaces" });
  throw new Error("Shauth sign-in did not redirect");
}
