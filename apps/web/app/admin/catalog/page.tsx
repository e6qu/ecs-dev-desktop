// SPDX-License-Identifier: AGPL-3.0-or-later
import { CatalogPageContent } from "../../../components/CatalogPageContent";
import { LiveRefresh, ADMIN_LIST_REFRESH_MS } from "../../../components/LiveRefresh";
import { isAdminViewer } from "../../../lib/principal";
import { getCatalog } from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

export default async function AdminCatalogPage() {
  if (!(await isAdminViewer())) return null;
  const entries = await getCatalog().list();
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Converge on out-of-band catalog changes (another admin adds/edits an image) without a
  // hard reload; router.refresh preserves in-progress form input in CatalogPageContent.
  return (
    <>
      <LiveRefresh intervalMs={ADMIN_LIST_REFRESH_MS} />
      <CatalogPageContent entries={entries} />
    </>
  );
}
