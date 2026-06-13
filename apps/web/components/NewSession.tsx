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

const api = new ApiClient({ baseUrl: "" });

interface CatalogOption {
  name: string;
  image: string;
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
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [ghConnected, setGhConnected] = useState(true);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create-repo form.
  const [ns, setNs] = useState("");
  const [repoName, setRepoName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const reposRes = await fetch("/api/github/repos");
        if (reposRes.status === 409) {
          setGhConnected(false);
          setRepos([]);
          return;
        }
        if (reposRes.ok) setRepos(reposResponse.parse(await reposRes.json()).repos);
        const nsRes = await fetch("/api/github/namespaces");
        if (nsRes.ok) {
          const list = namespacesResponse.parse(await nsRes.json()).namespaces;
          setNamespaces(list);
          if (list.length > 0) setNs((list.find((n) => n.canCreate) ?? list[0]).login);
        }
      } catch {
        setError("failed to load GitHub repositories");
      }
    })();
  }, []);

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
    if (namespace === undefined || repoName.trim().length === 0) return;
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
      if (!res.ok) throw new Error(`creating the repository failed (${String(res.status)})`);
      const { repo } = createRepoResponse.parse(await res.json());
      await startSession(repo.cloneUrl, repo.defaultBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create the repository");
      setBusy(false);
    }
  }

  if (images.length === 0) {
    return <p className="mono">No base images in the catalog yet — ask an admin to add one.</p>;
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="field">
        <label className="mono" htmlFor="session-image">
          environment
        </label>
        <select
          id="session-image"
          className="select"
          value={image}
          onChange={(e) => {
            setImage(e.target.value);
          }}
        >
          {images.map((opt) => (
            <option key={opt.image} value={opt.image}>
              {opt.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          data-testid={TESTID.blankSession}
          disabled={busy}
          onClick={() => void startSession()}
        >
          blank session
        </button>
      </div>

      {!ghConnected ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          Connect GitHub to browse and create repositories — sign in with GitHub.
        </p>
      ) : (
        <>
          <section>
            <h2>Start from a repository</h2>
            <input
              className="input"
              placeholder="search repositories…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
            {repos === null ? (
              <p className="mono">loading…</p>
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
                      disabled={busy}
                      onClick={() => void startSession(repo.cloneUrl, repo.defaultBranch)}
                    >
                      start session
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && <li className="mono">no repositories match</li>}
              </ul>
            )}
          </section>

          <section data-testid={TESTID.createRepoPanel} data-enabled={String(createEnabled)}>
            <h2>Create a repository</h2>
            {createEnabled ? (
              <div className="stack" style={{ gap: 10 }}>
                <select
                  className="select"
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
                  disabled={busy || repoName.trim().length === 0}
                  onClick={() => void createAndStart()}
                >
                  create &amp; start session
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
        <p className="mono" style={{ color: "var(--st-error)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
