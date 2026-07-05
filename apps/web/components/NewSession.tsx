// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  createRepoResponse,
  namespacesResponse,
  reposResponse,
  type Namespace,
  type RepoSummary,
} from "../lib/github-types";
import { TESTID } from "../lib/testids";
import { StateBlock } from "./StateBlock";

const api = new ApiClient({ baseUrl: "" });

interface CatalogOption {
  name: string;
  image: string;
  description: string;
  tags: readonly string[];
  tools: readonly string[];
}

/**
 * New-session launcher: pick a base image, then start a session in one of the
 * user's GitHub repos, in a newly-created repo, or blank. The user's GitHub
 * token never reaches the browser — repo/namespace data comes from the
 * server-side `/api/github/*` routes. "Create repository" is grayed out (with the
 * reason) when the user lacks permission.
 */
export function NewSession({ images }: { images: readonly CatalogOption[] }) {
  const router = useRouter();
  const [image, setImage] = useState(images[0]?.image ?? "");
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [ghConnected, setGhConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The repo browser is collapsed by default and its list is fetched lazily, one
  // page at a time, on first expand — most sessions start blank or from a repo the
  // user already knows the name of, so there's no reason to always pay for the
  // GitHub round trip (and orgs can have far more repos than fit on one page).
  const [browseOpen, setBrowseOpen] = useState(false);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");

  // Create-repo form.
  const [ns, setNs] = useState("");
  const [repoName, setRepoName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const nsRes = await fetch("/api/github/namespaces");
        if (nsRes.status === 409) {
          setGhConnected(false);
          return;
        }
        if (nsRes.ok) {
          const list = namespacesResponse.parse(await nsRes.json()).namespaces;
          setNamespaces(list);
          if (list.length > 0) setNs((list.find((n) => n.canCreate) ?? list[0]).login);
        } else {
          // Surface the real failure — leaving `namespaces` empty would otherwise tell the
          // user "you do not have permission to create repositories", misattributing a
          // server error as a permission denial (§6.5 — no silent, misleading fallback).
          setError("failed to load GitHub namespaces");
        }
      } catch {
        setError("failed to load GitHub namespaces");
      }
    })();
  }, []);

  async function loadRepoPage(targetPage: number): Promise<void> {
    setReposLoading(true);
    try {
      const res = await fetch(`/api/github/repos?page=${String(targetPage)}`);
      if (res.status === 409) {
        setGhConnected(false);
        return;
      }
      if (res.ok) {
        const { repos: pageRepos, hasMore: more } = reposResponse.parse(await res.json());
        setRepos((prev) => (targetPage === 1 ? pageRepos : [...(prev ?? []), ...pageRepos]));
        setHasMore(more);
        setPage(targetPage);
      } else {
        setError("failed to load GitHub repositories");
      }
    } catch {
      setError("failed to load GitHub repositories");
    } finally {
      setReposLoading(false);
    }
  }

  function toggleBrowse(): void {
    const opening = !browseOpen;
    setBrowseOpen(opening);
    if (opening && repos === null) void loadRepoPage(1);
  }

  const filtered = useMemo(
    () =>
      (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(search.trim().toLowerCase())),
    [repos, search],
  );
  const creatable = namespaces.filter((n) => n.canCreate);
  const createEnabled = creatable.length > 0;
  const noCreateReason =
    namespaces.find((n) => n.reason !== undefined)?.reason ??
    "you do not have permission to create repositories";

  async function startSession(repoUrl?: string, repoRef?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.createWorkspace({
        baseImage: image,
        ...(repoUrl !== undefined ? { repoUrl } : {}),
        ...(repoRef !== undefined ? { repoRef } : {}),
      });
      router.push("/workspaces");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start the session");
      setBusy(false);
    }
  }

  async function createAndStart(): Promise<void> {
    const namespace = namespaces.find((n) => n.login === ns);
    if (namespace === undefined || repoName.trim().length === 0) {
      setError("Pick an owner and enter a repository name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/github/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: ns,
          name: repoName.trim(),
          private: isPrivate,
          isPersonal: namespace.kind === "user",
        }),
      });
      if (!res.ok) {
        // Surface the API's specific, user-correctable message (e.g. "repository name unavailable")
        // instead of an opaque status code; fall back to the status only if there's no error body.
        const body: unknown = await res.json().catch(() => null);
        const serverMsg =
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : `creating the repository failed (${String(res.status)})`;
        throw new Error(serverMsg);
      }
      const { repo } = createRepoResponse.parse(await res.json());
      await startSession(repo.cloneUrl, repo.defaultBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create the repository");
      setBusy(false);
    }
  }

  if (images.length === 0) {
    return (
      <StateBlock
        title="No base images in the catalog"
        detail="Ask an administrator to add one before starting a session."
      />
    );
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="stack" style={{ gap: 12 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          environment
        </div>
        <div className="picker-grid">
          {images.map((opt) => {
            const selected = opt.image === image;
            return (
              <button
                key={opt.image}
                type="button"
                aria-pressed={selected}
                className={`picker-card${selected ? " on" : ""}`}
                data-testid={TESTID.catalogPickerOption}
                data-image={opt.image}
                data-selected={String(selected)}
                data-tags={opt.tags.join(",")}
                data-tools={opt.tools.join(",")}
                onClick={() => {
                  setImage(opt.image);
                }}
              >
                <div className="picker-head">
                  <span className="picker-title">{opt.name}</span>
                  <span className="badge accent">{selected ? "selected" : "available"}</span>
                </div>
                <div className="picker-sub">{opt.image}</div>
                {opt.description !== "" && <p className="picker-copy">{opt.description}</p>}
                {opt.tags.length > 0 && (
                  <div className="pill-row">
                    {opt.tags.map((tag) => (
                      <span key={tag} className="pill">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {opt.tools.length > 0 && (
                  <div className="meta-line">
                    <span className="meta-label">tools</span>
                    <span className="meta-value">{opt.tools.join(" · ")}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn"
          data-testid={TESTID.blankSession}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void startSession()}
        >
          {busy ? "starting…" : "blank session"}
        </button>
      </section>

      {!ghConnected ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          Connect GitHub to browse and create repositories — sign in with GitHub.
        </p>
      ) : (
        <>
          <section>
            <h2>
              <button
                type="button"
                className="btn"
                aria-expanded={browseOpen}
                aria-controls="session-repo-browse"
                data-testid={TESTID.sessionRepoBrowseToggle}
                data-open={String(browseOpen)}
                onClick={toggleBrowse}
              >
                <span aria-hidden="true">{browseOpen ? "▾" : "▸"}</span> Start from a repository
              </button>
            </h2>
            {browseOpen && (
              <div id="session-repo-browse" className="stack" style={{ gap: 10 }}>
                <input
                  className="input"
                  aria-label="search repositories"
                  placeholder="search repositories…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                />
                {repos === null ? (
                  <p className="state-note" role="status">
                    loading repositories…
                  </p>
                ) : (
                  <ul className="list">
                    {filtered.map((repo) => (
                      <li
                        key={repo.fullName}
                        className="row"
                        data-testid={TESTID.sessionRepoRow}
                        data-repo={repo.fullName}
                        data-private={String(repo.private)}
                      >
                        <span>
                          {repo.fullName}{" "}
                          {repo.private ? <span className="mono">(private)</span> : null}
                        </span>
                        <button
                          type="button"
                          className="btn primary"
                          data-testid={TESTID.startSession}
                          aria-busy={busy}
                          disabled={busy}
                          onClick={() => void startSession(repo.cloneUrl, repo.defaultBranch)}
                        >
                          {busy ? "starting…" : "start session"}
                        </button>
                      </li>
                    ))}
                    {filtered.length === 0 && <li className="mono">no repositories match</li>}
                    {hasMore && (
                      <li className="row">
                        <button
                          type="button"
                          className="btn"
                          data-testid={TESTID.sessionRepoLoadMore}
                          aria-busy={reposLoading}
                          disabled={reposLoading}
                          onClick={() => void loadRepoPage(page + 1)}
                        >
                          {reposLoading ? "loading…" : "load more repositories"}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section data-testid={TESTID.createRepoPanel} data-enabled={String(createEnabled)}>
            <h2>Create a repository</h2>
            {createEnabled ? (
              <div className="stack" style={{ gap: 10 }}>
                <select
                  className="select"
                  aria-label="repository owner"
                  value={ns}
                  onChange={(e) => {
                    setNs(e.target.value);
                  }}
                >
                  {namespaces.map((n) => (
                    <option key={n.login} value={n.login} disabled={!n.canCreate}>
                      {n.login}
                      {n.canCreate ? "" : ` — ${n.reason ?? "no permission"}`}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  aria-label="repository name"
                  placeholder="repository name"
                  value={repoName}
                  onChange={(e) => {
                    setRepoName(e.target.value);
                  }}
                />
                <label className="mono">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => {
                      setIsPrivate(e.target.checked);
                    }}
                  />{" "}
                  private
                </label>
                <button
                  type="button"
                  className="btn primary"
                  data-testid={TESTID.startSession}
                  aria-busy={busy}
                  disabled={busy || repoName.trim().length === 0}
                  onClick={() => void createAndStart()}
                >
                  {busy ? "creating…" : "create & start session"}
                </button>
              </div>
            ) : (
              <p className="mono" style={{ color: "var(--dim)" }}>
                Creating repositories is unavailable: {noCreateReason}.
              </p>
            )}
          </section>
        </>
      )}

      {error !== null && (
        <p role="alert" className="mono" style={{ color: "var(--st-error)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
