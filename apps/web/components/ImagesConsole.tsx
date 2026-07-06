// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type {
  BuildLogChunkDto,
  BuildTargetDto,
  ImageBuildRecordDto,
  ImageMetadataDto,
} from "@edd/api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { humanBytes } from "../lib/format";
import { usePoll } from "../lib/usePoll";

type ImageEntry = ImageMetadataDto | { repo: string; tag: null };
type BuildRow = Partial<ImageBuildRecordDto> & {
  buildId: string;
  status: string;
  phase?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  ref?: string;
  initiator?: string;
};

const BUILDS_POLL_MS = 5000;
const LOGS_POLL_MS = 3000;

function shortRepo(repo: string): string {
  // Drop the "<prefix>/" so the operator sees "control-plane" / "golden/omnibus".
  const i = repo.indexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

function statusColor(status: string): string {
  if (status === "succeeded") return "var(--accent, #9fef00)";
  if (status === "in_progress") return "var(--accent, #9fef00)";
  if (status === "stopped") return "var(--dim)";
  return "var(--st-error, #ff6b6b)";
}

/** The admin Images console: per-image size + layer breakdown, a Rebuild trigger,
 * the last 20 builds, and live streaming logs for a selected build. */
export function ImagesConsole() {
  const loadImages = useCallback(
    () => fetch("/api/admin/images").then((r) => r.json() as Promise<{ images: ImageEntry[] }>),
    [],
  );
  const loadBuilds = useCallback(
    () => fetch("/api/admin/builds").then((r) => r.json() as Promise<{ builds: BuildRow[] }>),
    [],
  );
  const { data: imagesData } = usePoll(loadImages, 30_000, "images unavailable");
  const { data: buildsData } = usePoll(loadBuilds, BUILDS_POLL_MS, "builds unavailable");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [target, setTarget] = useState<BuildTargetDto>("web");
  const [tag, setTag] = useState("");
  const [ref, setRef] = useState("main");
  const [triggering, setTriggering] = useState(false);
  const [selectedBuild, setSelectedBuild] = useState<string | null>(null);

  async function triggerBuild(): Promise<void> {
    if (tag.trim() === "" || ref.trim() === "") return;
    setTriggering(true);
    try {
      const res = await fetch("/api/admin/builds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, tag: tag.trim(), ref: ref.trim() }),
      });
      if (res.ok) {
        const { buildId } = (await res.json()) as { buildId: string };
        setSelectedBuild(buildId);
      }
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Images</h2>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>image</th>
                <th>tag</th>
                <th>size</th>
                <th>layers</th>
                <th>arch</th>
                <th>pushed</th>
              </tr>
            </thead>
            <tbody>
              {(imagesData?.images ?? []).map((img) => {
                const meta = img.tag !== null ? img : null;
                const open = expanded === img.repo;
                return (
                  <ImageRows
                    key={img.repo}
                    repo={img.repo}
                    meta={meta}
                    open={open}
                    onToggle={() => {
                      setExpanded(open ? null : img.repo);
                    }}
                  />
                );
              })}
              {imagesData === null && (
                <tr>
                  <td colSpan={6} className="state-note">
                    loading images…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Rebuild</h2>
        <p className="state-note" style={{ margin: 0 }}>
          <strong>web</strong> rebuilds the control-plane app only (fast, ~minutes).{" "}
          <strong>golden</strong> rebuilds the workspace images. <strong>all</strong> does both.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as BuildTargetDto);
            }}
            aria-label="build target"
          >
            <option value="web">web (control-plane)</option>
            <option value="golden">golden (workspaces)</option>
            <option value="all">all</option>
          </select>
          <input
            className="mono"
            placeholder="tag (git sha)"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
            }}
            style={{ minWidth: 130 }}
          />
          <input
            className="mono"
            placeholder="git ref"
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
            }}
            style={{ minWidth: 130 }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={triggering || tag.trim() === "" || ref.trim() === ""}
            onClick={() => {
              void triggerBuild();
            }}
          >
            {triggering ? "starting…" : "Start build"}
          </button>
        </div>
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Recent builds</h2>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>status</th>
                <th>build</th>
                <th>ref</th>
                <th>started</th>
                <th>duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(buildsData?.builds ?? []).map((b) => (
                <tr key={b.buildId} data-status={b.status}>
                  <td style={{ color: statusColor(b.status) }}>
                    {b.status}
                    {b.phase !== undefined && b.status === "in_progress" ? ` · ${b.phase}` : ""}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.buildId.split(":").pop()}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.ref?.slice(0, 10) ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.startedAt !== undefined ? new Date(b.startedAt).toLocaleString() : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.durationMs !== undefined ? `${String(Math.round(b.durationMs / 1000))}s` : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setSelectedBuild(b.buildId);
                      }}
                    >
                      logs
                    </button>
                  </td>
                </tr>
              ))}
              {buildsData === null && (
                <tr>
                  <td colSpan={6} className="state-note">
                    loading builds…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedBuild !== null && (
        <BuildLogs
          buildId={selectedBuild}
          onClose={() => {
            setSelectedBuild(null);
          }}
        />
      )}
    </div>
  );
}

function ImageRows({
  repo,
  meta,
  open,
  onToggle,
}: {
  repo: string;
  meta: ImageMetadataDto | null;
  open: boolean;
  onToggle: () => void;
}) {
  const maxLayer = meta ? Math.max(1, ...meta.layers.map((l) => l.sizeBytes)) : 1;
  return (
    <>
      <tr style={{ cursor: meta ? "pointer" : "default" }} onClick={meta ? onToggle : undefined}>
        <td className="mono">
          {meta ? (open ? "▾ " : "▸ ") : ""}
          {shortRepo(repo)}
        </td>
        <td className="mono" style={{ fontSize: 12 }}>
          {meta?.tag ?? "no image"}
        </td>
        <td>{meta ? humanBytes(meta.compressedBytes) : "—"}</td>
        <td>{meta?.layerCount ?? "—"}</td>
        <td className="mono" style={{ fontSize: 12 }}>
          {meta?.architecture ?? "—"}
        </td>
        <td className="mono" style={{ fontSize: 12 }}>
          {meta?.pushedAt !== undefined ? new Date(meta.pushedAt).toLocaleDateString() : "—"}
        </td>
      </tr>
      {open && meta && (
        <tr>
          <td colSpan={6} style={{ padding: "4px 12px 12px" }}>
            <div className="stack" style={{ gap: 3 }}>
              {meta.layers.map((l, i) => (
                <div
                  key={l.digest}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
                >
                  <span className="mono" style={{ color: "var(--dim)", width: 28 }}>
                    {i + 1}
                  </span>
                  <div
                    style={{
                      height: 10,
                      width: `${String((l.sizeBytes / maxLayer) * 100)}%`,
                      minWidth: 2,
                      background: "var(--accent, #9fef00)",
                      borderRadius: 2,
                      opacity: 0.75,
                    }}
                  />
                  <span className="mono" style={{ color: "var(--dim)" }}>
                    {humanBytes(l.sizeBytes)}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function BuildLogs({ buildId, onClose }: { buildId: string; onClose: () => void }) {
  const tokenRef = useRef<string | undefined>(undefined);
  const [lines, setLines] = useState<{ at: string; message: string }[]>([]);
  const [status, setStatus] = useState<string>("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    tokenRef.current = undefined;
    setLines([]);
    const tick = async () => {
      const q = tokenRef.current === undefined ? "" : `&token=${encodeURIComponent(tokenRef.current)}`;
      const res = await fetch(`/api/admin/builds/logs?buildId=${encodeURIComponent(buildId)}${q}`);
      if (!res.ok || !active) return;
      const chunk = (await res.json()) as BuildLogChunkDto & { status: string; phase?: string };
      setStatus(chunk.phase !== undefined ? `${chunk.status} · ${chunk.phase}` : chunk.status);
      if (chunk.lines.length > 0) setLines((prev) => [...prev, ...chunk.lines]);
      if (chunk.nextToken !== undefined) tokenRef.current = chunk.nextToken;
    };
    void tick();
    const h = window.setInterval(() => void tick(), LOGS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(h);
    };
  }, [buildId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  return (
    <section className="stack" style={{ gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          Build logs <span className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>{status}</span>
        </h2>
        <button type="button" className="btn" onClick={onClose}>
          close
        </button>
      </div>
      <div
        className="mono"
        style={{
          maxHeight: 380,
          overflowY: "auto",
          fontSize: 12,
          border: "1px solid var(--line, #333)",
          borderRadius: 6,
          padding: "8px 10px",
        }}
      >
        {lines.length === 0 ? (
          <p className="state-note">waiting for log output…</p>
        ) : (
          lines.map((l, i) => (
            <div key={`${l.at}-${String(i)}`}>
              <span style={{ color: "var(--dim)" }}>{new Date(l.at).toLocaleTimeString()} </span>
              {l.message}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
