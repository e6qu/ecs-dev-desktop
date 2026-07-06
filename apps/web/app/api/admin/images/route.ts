// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getImageOps, imageRepos } from "../../../../lib/image-ops";
import { errorField, log } from "../../../../lib/logger";
import { withObservability } from "../../../../lib/observability";

/** The golden variants this deployment builds (space-separated env; default omnibus). */
function goldenVariants(): string[] {
  return (process.env.EDD_GOLDEN ?? "omnibus").split(/\s+/).filter((v) => v.length > 0);
}

// GET /api/admin/images            → every platform image with its latest tag's metadata
// GET /api/admin/images?repo=&tag= → one image tag's full metadata (per-layer sizes)
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const tag = url.searchParams.get("tag");
  const ops = getImageOps();

  if (repo !== null && tag !== null) {
    const meta = await ops.getImageMetadata(repo, tag);
    if (meta === null) return NextResponse.json({ error: "image not found" }, { status: 404 });
    return NextResponse.json(meta);
  }

  const prefix = process.env.EDD_APP_NAME ?? "";
  const repos = imageRepos(prefix, goldenVariants());
  const images = await Promise.all(
    repos.map(async (r) => {
      try {
        const tags = await ops.listImageTags(r, 1);
        if (tags.length === 0) return { repo: r, tag: null };
        return (await ops.getImageMetadata(r, tags[0])) ?? { repo: r, tag: null };
      } catch (err) {
        log.warn("image metadata failed for one repo", { repo: r, error: errorField(err) });
        return { repo: r, tag: null };
      }
    }),
  );
  return NextResponse.json({ images });
}

export const GET = withObservability("admin.images", handleGET);
