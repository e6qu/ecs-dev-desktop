// SPDX-License-Identifier: AGPL-3.0-or-later
import { CatalogPageContent } from "../../../components/CatalogPageContent";
import { isAdminViewer } from "../../../lib/principal";
import { getCatalog } from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

export default async function AdminCatalogPage() {
  if (!(await isAdminViewer())) return null;
  const entries = await getCatalog().list();
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <CatalogPageContent entries={entries} />;
}
