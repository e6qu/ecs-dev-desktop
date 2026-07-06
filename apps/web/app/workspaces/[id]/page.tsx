// SPDX-License-Identifier: AGPL-3.0-or-later
import { SignedOutBlock } from "../../../components/SignedOutBlock";
import { WorkspaceLive } from "../../../components/WorkspaceLive";
import { getPagePrincipal } from "../../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * Per-workspace live status page — where a user lands right after starting a
 * session. Ownership is enforced by the API routes the client component polls
 * (GET /api/workspaces/:id and /logs both 403 non-owners), so this server shell
 * only gates on being signed in at all.
 */
export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await getPagePrincipal();
  const { id } = await params;
  if (principal === null) {
    return <SignedOutBlock detail="Sign in to view your workspace." />;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">session</div>
          <h1 className="mono">{id}</h1>
          <p>Live status of your dev desktop — it opens itself below once it&apos;s ready.</p>
        </div>
      </div>
      <WorkspaceLive id={id} />
    </>
  );
}
