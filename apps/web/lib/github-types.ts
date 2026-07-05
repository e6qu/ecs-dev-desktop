// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * Client-safe GitHub DTO shapes (zod schemas + types) for the session launcher,
 * shared by the server adapter (`github.ts`) and the browser (which parses the
 * API responses). No server-only imports, so it's safe in a client component.
 */
const repoSummary = z.object({
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  cloneUrl: z.string(),
  htmlUrl: z.string(),
});
export type RepoSummary = z.infer<typeof repoSummary>;

const namespace = z.object({
  login: z.string(),
  kind: z.enum(["user", "org"]),
  canCreate: z.boolean(),
  reason: z.string().optional(),
});
export type Namespace = z.infer<typeof namespace>;

export const reposResponse = z.object({ repos: z.array(repoSummary), hasMore: z.boolean() });
export const namespacesResponse = z.object({ namespaces: z.array(namespace) });
export const createRepoResponse = z.object({ repo: repoSummary });
