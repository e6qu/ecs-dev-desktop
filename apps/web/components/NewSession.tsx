// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import {
  editorKind,
  MAX_SNAPSHOT_INTERVAL_MS,
  MIN_SNAPSHOT_INTERVAL_MS,
  type EditorKindDto,
} from "@edd/api-contracts";
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
const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 5;
const MIN_SNAPSHOT_INTERVAL_MINUTES = MIN_SNAPSHOT_INTERVAL_MS / (60 * 1000);
const MAX_SNAPSHOT_INTERVAL_MINUTES = MAX_SNAPSHOT_INTERVAL_MS / (60 * 1000);

interface CatalogOption {
  name: string;
  image: string;
  description: string;
  tags: readonly string[];
  tools: readonly string[];
}

/** The ways to start a session — selected by radio, launched by ONE button. */
type StartMode = "blank" | "repo" | "public" | "create";

const MODE_META: Record<StartMode, { title: string; detail: string }> = {
  blank: {
    title: "Blank session",
    detail: "A scratch desktop with no repository — clone anything later from the terminal.",
  },
  repo: {
    title: "An existing repository",
    detail: "Pick a repository you can access; it's cloned into the session at boot.",
  },
  public: {
    title: "Public GitHub URL",
    detail: "Paste a public repository URL; no GitHub account link is required.",
  },
  create: {
    title: "Create a new repository",
    detail: "A fresh repository (in an organization or your own account), cloned at boot.",
  },
};

function publicGithubCloneUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const parts = url.pathname
    .replace(/\/$/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length !== 2) return null;
  const [owner, repoPart] = parts;
  const repo = repoPart.endsWith(".git") ? repoPart.slice(0, -4) : repoPart;
  if (owner === "" || repo === "") return null;
  return `https://github.com/${owner}/${repo}.git`;
}

function snapshotIntervalMsFromInput(input: string): number | null {
  const minutes = Number(input);
  if (!Number.isInteger(minutes)) return null;
  const ms = minutes * 60 * 1000;
  if (ms < MIN_SNAPSHOT_INTERVAL_MS || ms > MAX_SNAPSHOT_INTERVAL_MS) return null;
  return ms;
}

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
  // Per-session interface; defaults to OpenVSCode (every curated image's default).
  const [editor, setEditor] = useState<"" | EditorKindDto>("openvscode");
  const [snapshotIntervalMinutes, setSnapshotIntervalMinutes] = useState(
    String(DEFAULT_SNAPSHOT_INTERVAL_MINUTES),
  );
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
  const [publicRepoUrl, setPublicRepoUrl] = useState("");
  const [publicRepoRef, setPublicRepoRef] = useState("");

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
    snapshotIntervalMsFromInput(snapshotIntervalMinutes) !== null &&
    (mode === "blank" ||
      (mode === "repo" && selectedRepo !== null) ||
      (mode === "public" && publicRepoUrl.trim().length > 0) ||
      (mode === "create" && createEnabled && repoName.trim().length > 0));

  async function launch(repoUrl?: string, repoRef?: string): Promise<string> {
    const ws = await api.createWorkspace({
      baseImage: image,
      ...(editor === "" ? {} : { editor }),
      snapshotIntervalMs: snapshotIntervalMsFromInput(snapshotIntervalMinutes) ?? undefined,
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
      } else if (mode === "public") {
        const parsed = publicGithubCloneUrl(publicRepoUrl);
        if (parsed === null) throw new Error("Enter a valid public GitHub repository URL.");
        wsId = await launch(parsed, publicRepoRef.trim() === "" ? undefined : publicRepoRef.trim());
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
      // autoopen=1: the status page opens the editor itself the moment the
      // workspace is functional (with a visible cancel) — only on this
      // launch-initiated visit, never on later direct visits to the page.
      router.push(`/workspaces/${wsId}?autoopen=1`);
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
            const disabled = (m === "repo" || m === "create") && !ghConnected;
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
          <div className="stack" style={{ gap: 8 }}>
            <p className="mono" style={{ color: "var(--dim)", margin: 0 }}>
              Repository modes need a connected GitHub account.
            </p>
            <a className="btn" href="/api/github/connect/start">
              Connect GitHub
            </a>
          </div>
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

        {mode === "public" && (
          <div className="stack" style={{ gap: 10 }}>
            <input
              className="input"
              aria-label="public GitHub repository URL"
              placeholder="https://github.com/owner/repo"
              value={publicRepoUrl}
              onChange={(e) => {
                setPublicRepoUrl(e.target.value);
              }}
            />
            <input
              className="input"
              aria-label="repository ref"
              placeholder="branch, tag, or commit (optional)"
              value={publicRepoRef}
              onChange={(e) => {
                setPublicRepoRef(e.target.value);
              }}
            />
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

      <section className="stack" style={{ gap: 12 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          interface
        </div>
        <select
          className="select"
          aria-label="session interface"
          data-testid={TESTID.sessionEditor}
          data-editor={editor}
          value={editor}
          onChange={(e) => {
            setEditor(editorKind.parse(e.target.value));
          }}
          style={{ alignSelf: "flex-start" }}
        >
          {/* All curated images default to OpenVSCode, so the old "environment
              default" option was indistinguishable from picking OpenVSCode — merged. */}
          <option value="openvscode">OpenVSCode (Default) — full IDE in the browser</option>
          <option value="monaco">Monaco — lightweight first-party editor</option>
          <option value="claude">Claude Code — local web UI</option>
          <option value="codex">Codex — local web UI</option>
        </select>
        <label className="stack" style={{ gap: 6, alignSelf: "flex-start" }}>
          <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            snapshot interval
          </span>
          <input
            className="input"
            type="number"
            min={MIN_SNAPSHOT_INTERVAL_MINUTES}
            max={MAX_SNAPSHOT_INTERVAL_MINUTES}
            step={1}
            value={snapshotIntervalMinutes}
            onChange={(e) => {
              setSnapshotIntervalMinutes(e.target.value);
            }}
            style={{ width: 180 }}
          />
        </label>
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
