// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImageEntryDto, WorkspaceDto } from "@edd/api-contracts";
import { SSH_BASE_DOMAIN } from "@edd/config";
import { isWorkspaceLabel, workspacePrincipal, workspaceSshHost } from "@edd/core";

/**
 * Enrich a workspace DTO with the presentation data the UI needs to render it WITHOUT
 * re-fetching + joining the catalog or re-deriving the SSH convention: the resolved
 * catalog `imageName`/description/tags/tools, and the ready-to-run `ssh …` command
 * (when the SSH subdomain is configured). This is the single source of that join, used
 * by the `GET /api/workspaces` route (so a reskinned frontend gets it for free) and the
 * server-rendered pages alike — neither re-implements the lookup.
 */
export function enrichWorkspace(
  ws: WorkspaceDto,
  catalogByImage: ReadonlyMap<string, BaseImageEntryDto>,
): WorkspaceDto {
  const entry = catalogByImage.get(ws.baseImage);
  // Single-gateway routing carries the workspace id in the username; only meaningful
  // once a deployment has provisioned the SSH subdomain zone (EDD_SSH_BASE_DOMAIN).
  const sshCommand =
    SSH_BASE_DOMAIN !== "" && isWorkspaceLabel(ws.id)
      ? `ssh ${workspacePrincipal(ws.id)}@${workspaceSshHost(ws.id, SSH_BASE_DOMAIN)}`
      : undefined;
  return {
    ...ws,
    ...(entry === undefined
      ? {}
      : {
          imageName: entry.name,
          imageDescription: entry.description,
          imageTags: entry.tags,
          imageTools: entry.tools,
        }),
    ...(sshCommand === undefined ? {} : { sshCommand }),
  };
}

/** Build the `image → entry` lookup the enrichment needs from the catalog list. */
export function catalogByImage(
  entries: readonly BaseImageEntryDto[],
): ReadonlyMap<string, BaseImageEntryDto> {
  return new Map(entries.map((e) => [e.image, e]));
}
