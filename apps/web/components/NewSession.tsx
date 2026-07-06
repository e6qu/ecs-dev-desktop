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

/** The three ways to start a session — selected by radio, launched by ONE button. */
type StartMode = "blank" | "repo" | "create";

const MODE_META: Record<StartMode, { title: string; detail: string }> = {
  blank: {
    title: "Blank session",
    detail: "A scratch desktop with no repository — clone anything later from the terminal.",
  },
  repo: {
    title: "An existing repository",
    detail: "Pick a repository you can access; it's cloned into the session at boot.",
  },
  create: {
    title: "Create a new repository",
    detail: "A fresh repository (in an organization or your own account), cloned at boot.",
  },
};

/**
 * New-session launcher: pick a base image, choose HOW to start (blank / existing
 * repo / new repo — radio modes), then one prominent Start. The user's GitHub
 * token never reaches the browser — repo/namespace data comes from the
 * server-side `/api/github/*` routes. On success the browser lands on the
 * workspace's live status page (`/workspaces/<id>`), which follows the boot.
 */
export function NewSession({ images }: { images: readonly CatalogOption[] }) {
  const router = useRouter();
  const [image, setImage] = useState(images[0]?.image ?? "");
  const [mode, setMode] = useState<StartMode>("blank");
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [ghConnected, setGhConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Existing-repo mode: lazy, paginated browse (fetched on first entry into the
  // mode); a row SELECTS the repo — the shared Start button launches it.
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);

  // Create-repo mode.
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

  function selectMode(next: StartMode): void {
    setMode(next);
    setError(null);
    if (next === "repo" && repos === null) void loadRepoPage(1);
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

  const startReady =
    !busy &&
    image !== "" &&
    (mode === "blank" ||
      (mode === "repo" && selectedRepo !== null) ||
      (mode === "create" && createEnabled && repoName.trim().length > 0));

  async function launch(repoUrl?: string, repoRef?: string): Promise<string> {
    const ws = await api.createWorkspace({
      baseImage: image,
      ...(repoUrl !== undefined ? { repoUrl } : {}),
      ...(repoRef !== undefined ? { repoRef } : {}),
    });
    return ws.id;
  }

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let wsId: string;
      if (mode === "repo") {
        if (selectedRepo === null) throw new Error("Pick a repository first.");
        wsId = await launch(selectedRepo.cloneUrl, selectedRepo.defaultBranch);
      } else if (mode === "create") {
        const namespace = namespaces.find((n) => n.login === ns);
        if (namespace === undefined || repoName.trim().length === 0) {
          throw new Error("Pick an owner and enter a repository name.");
        }
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
          // Surface the API's specific, user-correctable message (e.g. "repository name
          // unavailable") instead of an opaque status code.
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
        wsId = await launch(repo.cloneUrl, repo.defaultBranch);
      } else {
        wsId = await launch();
      }
      // Land on the live status page — it follows the boot and opens the editor.
      router.push(`/workspaces/${wsId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start the session");
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
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          source
        </div>
        <p style={{ margin: 0 }}>
          A dev desktop works best backed by a git repository you have access to — in one of your
          organizations or your own account (e.g.{" "}
          <code className="mono">github.com/&lt;your-login&gt;</code>). You can also start blank and
          clone later.
        </p>
        <div role="radiogroup" aria-label="session source" className="stack" style={{ gap: 8 }}>
          {(Object.keys(MODE_META) as StartMode[]).map((m) => {
            const meta = MODE_META[m];
            const disabled = m !== "blank" && !ghConnected;
            const selected = mode === m;
            return (
              <label
                key={m}
                data-testid={TESTID.sessionModeOption}
                data-mode={m}
                data-selected={String(selected)}
                className={`picker-card${selected ? " on" : ""}`}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "baseline",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                <input
                  type="radio"
                  name="session-mode"
                  value={m}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => {
                    selectMode(m);
                  }}
                />
                <span>
                  <strong>{meta.title}</strong>
                  <br />
                  <span style={{ color: "var(--dim)", fontSize: 13 }}>{meta.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!ghConnected && (
          <p className="mono" style={{ color: "var(--dim)" }}>
            Repository modes need a connected GitHub account — sign in with GitHub.
          </p>
        )}

        {mode === "repo" && ghConnected && (
          <div className="stack" style={{ gap: 10 }}>
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
                {filtered.map((repo) => {
                  const selected = selectedRepo?.fullName === repo.fullName;
                  return (
                    <li
                      key={repo.fullName}
                      className="row"
                      data-testid={TESTID.sessionRepoRow}
                      data-repo={repo.fullName}
                      data-private={String(repo.private)}
                      data-selected={String(selected)}
                    >
                      <label style={{ display: "flex", gap: 8, cursor: "pointer", flex: 1 }}>
                        <input
                          type="radio"
                          name="session-repo"
                          checked={selected}
                          onChange={() => {
                            setSelectedRepo(repo);
                          }}
                        />
                        <span>
                          {repo.fullName}{" "}
                          {repo.private ? <span className="mono">(private)</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
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

        {mode === "create" && ghConnected && (
          <div data-testid={TESTID.createRepoPanel} data-enabled={String(createEnabled)}>
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
                      {n.kind === "user" ? " (your account)" : ""}
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
              </div>
            ) : (
              <p className="mono" style={{ color: "var(--dim)" }}>
                Creating repositories is unavailable: {noCreateReason}.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn primary"
          style={{ fontSize: 16, padding: "10px 28px", alignSelf: "flex-start" }}
          data-testid={TESTID.sessionStart}
          aria-busy={busy}
          disabled={!startReady}
          onClick={() => void start()}
        >
          {busy ? "starting your dev desktop…" : "Start session"}
        </button>
        {busy && (
          <p className="mono" role="status" style={{ color: "var(--dim)", fontSize: 12 }}>
            launching — you&apos;ll land on the session&apos;s live status page in a moment…
          </p>
        )}
      </section>

      {error !== null && (
        <p role="alert" className="mono" style={{ color: "var(--st-error)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
