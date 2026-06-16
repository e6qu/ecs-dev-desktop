// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

export default function BaseImagesRedirectPage() {
  redirect("/admin/catalog");
}
