// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createWorkspaceRequest, type WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { ComputeUnavailableError, QuotaExceededError } from "@edd/control-plane";
import {
  baseImage,
  ownerId,
  parseGitRemote,
  repoRef,
  repositoryProblem,
  unavailableError,
  withinWorkspaceQuota,
  workspaceId,
  type GitRemoteProbe,
  type OfferedCredential,
} from "@edd/core";

import {
  authenticate,
  badRequest,
  conflict,
  domainErrorResponse,
  forbidden,
  isResponse,
  unprocessable,
} from "../../../lib/api";
import { getCatalog, getCatalogList, getControlPlane } from "../../../lib/control-plane";
import { log } from "../../../lib/logger";
import { getGitProvider } from "../../../lib/git-provider";
import { gitIntegration } from "../../../lib/git-integration";
import { probeGitRemoteOverHttps, probeGitRemoteOverSsh } from "../../../lib/git-remote";
import { getGitSshKeys } from "../../../lib/git-credentials";
import { gitHostKnownHosts } from "../../../lib/github";
import { getMetrics } from "../../../lib/metrics";
import { catalogByImage, enrichWorkspace } from "../../../lib/workspace-enrich";
import { resolveOwnerEmail } from "../../../lib/owner-email";
import { devAuthEnabled } from "../../../lib/principal";
import { withObservability } from "../../../lib/observability";
import { workspaceLimit } from "../../../lib/quota";
import { recordQuotaUsage } from "../../../lib/quota-metrics";

// GET /api/workspaces — admins see all; everyone else sees their own.
async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const cp = await getControlPlane();
  const raw =
    principal.role === "admin" ? await cp.list() : await cp.list({ ownerId: principal.id });
  // Return ready-to-render DTOs: resolve the catalog image + ssh command server-side so
  // the UI (and any reskinned/external client) renders without re-joining the catalog.
  const byImage = catalogByImage(await getCatalogList());
  const workspaces = raw.map((ws) => enrichWorkspace(ws, byImage));
  return NextResponse.json({ workspaces });
}

// POST /api/workspaces — create a workspace owned by the caller.
async function handlePOST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("create", "Workspace")) return forbidden();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = createWorkspaceRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  const image = baseImage(parsed.data.baseImage);
  // Workspaces may only launch from an enabled catalog entry (the allow-list).
  const catalog = getCatalog();
  const enabled = await catalog.assertEnabled(image);
  if (!enabled.ok) return domainErrorResponse(enabled.error);
  // The editor: the caller's per-session choice, else the base-image's catalog
  // default (OpenVSCode when neither specifies) — flows to EDD_EDITOR_MODE.
  const editor = parsed.data.editor ?? (await catalog.editorForImage(image));

  const cp = await getControlPlane();

  // Enforce the per-role workspace quota, and emit the per-role utilization gauge
  // (plus a denial count when rejected) — the create path is the one place that
  // knows both the owner's current count and their role-derived limit.
  const owned = await cp.list({ ownerId: principal.id });
  // Terminated tombstones (deleted, awaiting the undelete-retention purge) freed
  // their quota at teardown — they must not count against a new create.
  const live = owned.filter((w) => w.state !== "terminated").length;
  const limit = workspaceLimit(principal.role);
  const allowed = withinWorkspaceQuota(live, limit);
  recordQuotaUsage(getMetrics(), { owned: live, limit, role: principal.role, allowed });
  if (!allowed) {
    return conflict(`workspace quota reached (${live.toString()})`);
  }

  // A session's repository must be clonable BEFORE the session exists: ask the host for
  // its ref advertisement the way `git clone` does, over the transport the URL names and
  // with what the workspace will present at boot — the owner's git token (none for a
  // public repo) over https, the owner's platform-generated SSH keys over ssh. A typo'd,
  // private-and-unlinked, or key-less URL is a clear 422 here rather than a workspace that
  // boots, fails its clone minutes later, and leaves git's "could not read Username" (or
  // "Permission denied (publickey)") in the boot log.
  if (parsed.data.repoUrl !== undefined) {
    const remote = parseGitRemote(parsed.data.repoUrl);
    if (remote === null) return badRequest("repoUrl is not a clone URL");
    let probe: GitRemoteProbe;
    let offered: OfferedCredential;
    if (remote.transport === "https") {
      const provider = await getGitProvider(ownerId(principal.id));
      const credential = provider === null ? null : await provider.gitCredential(repoRef(remote));
      offered = credential === null ? "none" : "token";
      probe = await probeGitRemoteOverHttps(remote, credential);
    } else {
      const integration = gitIntegration();
      const identities = integration.sshKeys
        ? await getGitSshKeys().materials(ownerId(principal.id))
        : [];
      offered = "ssh-keys";
      probe = await probeGitRemoteOverSsh(
        remote,
        identities,
        await gitHostKnownHosts(integration.apiUrl, integration.host),
      );
    }
    const problem = repositoryProblem(probe, remote.url, parsed.data.repoRef, offered);
    if (problem !== null) return unprocessable(problem);
  }

  // Record the owner's email so the proxy can match a caller to this workspace. A
  // present email must be valid (never silently dropped — §6.5) and a real (non-dev)
  // session with no email is rejected, since the workspace would be unopenable via the
  // proxy — better a clear 400 now than a created-but-inaccessible workspace.
  const ownerEmailResult = resolveOwnerEmail(principal.email, devAuthEnabled());
  if (!ownerEmailResult.ok) return badRequest(ownerEmailResult.reason);
  const ownerEmail = ownerEmailResult.email;
  let workspace: WorkspaceDto;
  try {
    // Instant create: persist the record (id pre-generated, quota enforced
    // atomically) and return it immediately — the browser navigates to the
    // workspace URL right away instead of holding this request open through the
    // multi-minute first image pull (which is how the ALB 60s idle timeout was
    // turning successful creates into 504s). The launch continues detached;
    // launchReserved NEVER rejects (a failure lands on the record as `error` +
    // reason for the status page's Retry/Delete), and the reconciler's
    // provisioning-timeout recovery is the backstop if this process dies.
    workspace = await cp.reserveWorkspace({
      ownerId: principal.id,
      ...(ownerEmail === undefined ? {} : { ownerEmail }),
      // Persist the owner's role so the admin quota view can flag this workspace against the
      // owner's per-role limit (the role is otherwise only known at this user's sign-in).
      ownerRole: principal.role,
      ...(parsed.data.repoUrl === undefined ? {} : { repoUrl: parsed.data.repoUrl }),
      ...(parsed.data.snapshotIntervalMs === undefined
        ? {}
        : { snapshotIntervalMs: parsed.data.snapshotIntervalMs }),
      ...(parsed.data.idleStopMs === undefined ? {} : { idleStopMs: parsed.data.idleStopMs }),
      ...(parsed.data.alwaysOn === undefined ? {} : { alwaysOn: parsed.data.alwaysOn }),
      ...(parsed.data.resources === undefined ? {} : { resources: parsed.data.resources }),
      baseImage: image,
      editor,
      // Authoritative cap: enforced ATOMICALLY in the create transaction (the read
      // check above is only a fast UX gate). Concurrent creates past `limit` cancel.
      // `null` = unlimited → no counter condition.
      ...(limit === null ? {} : { quotaLimit: limit }),
    });
    void cp
      .launchReserved(workspaceId(workspace.id), {
        ...(parsed.data.repoRef === undefined ? {} : { repoRef: parsed.data.repoRef }),
      })
      .catch((e: unknown) => {
        // Defensive only — launchReserved returns Results. A throw here would
        // otherwise be an unhandled rejection with no owner.
        log.error("detached workspace launch threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
  } catch (e) {
    // The compute backend couldn't launch the task — a handled, retryable failure
    // (→ 503), not an unexpected 500.
    if (e instanceof ComputeUnavailableError) {
      return domainErrorResponse(unavailableError(e.message));
    }
    // The atomic quota counter rejected a concurrent create that raced past the read
    // check — surface the same 409 the read check would have (closes the TOCTOU race).
    if (e instanceof QuotaExceededError) {
      recordQuotaUsage(getMetrics(), {
        owned: limit ?? 0,
        limit,
        role: principal.role,
        allowed: false,
      });
      return conflict(e.message);
    }
    throw e; // genuinely unexpected
  }
  // The control plane records `session.create` to the audit ledger (attributed
  // to the owner), so the cost model and admin feed see it without a route-level
  // emit. Same for start/stop/delete on their routes.
  return NextResponse.json(workspace, { status: 201 });
}

export const GET = withObservability("workspaces.list", handleGET);
export const POST = withObservability("workspaces.create", handlePOST);
