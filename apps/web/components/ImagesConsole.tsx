// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { ImageSourceStateDto, ImageMetadataDto } from "@edd/api-contracts";
import { useCallback, useState } from "react";

import { humanBytes } from "../lib/format";
import { usePoll } from "../lib/usePoll";

type ImageEntry = ImageMetadataDto | { repo: string; tag: null };

const SOURCE_POLL_MS = 5000;

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  throw new Error(`HTTP ${res.status}`);
}

function shortRepo(repo: string): string {
  // Drop the "<prefix>/" so the operator sees "control-plane" / "golden/omnibus".
  const i = repo.indexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

function statusColor(status: string): string {
  if (status === "succeeded") return "var(--accent, #9fef00)";
  if (status === "in_progress" || status === "queued" || status === "building") {
    return "var(--accent, #9fef00)";
  }
  if (status === "stopped") return "var(--dim)";
  return "var(--st-error, #ff6b6b)";
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? "—" : sha.slice(0, 12);
}

function LoadingRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="state-note">
        {label}
      </td>
    </tr>
  );
}

/** The admin Images console: per-image size + layer breakdown, a Rebuild trigger,
 * the last 20 builds, and live streaming logs for a selected build. */
export function ImagesConsole() {
  const loadImages = useCallback(
    () => fetch("/api/admin/images").then((r) => r.json() as Promise<{ images: ImageEntry[] }>),
    [],
  );
  const loadSource = useCallback(
    () => fetch("/api/admin/image-source").then((r) => jsonOrThrow<ImageSourceStateDto>(r)),
    [],
  );
  const { data: imagesData } = usePoll(loadImages, 30_000, "images unavailable");
  const { data: sourceData, error: sourceError } = usePoll(
    loadSource,
    SOURCE_POLL_MS,
    "image source unavailable",
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Source sync</h2>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <tbody>
              {sourceError === null ? (
                <>
                  <tr>
                    <th>repo</th>
                    <td className="mono">{sourceData?.repo ?? "loading…"}</td>
                    <th>branch</th>
                    <td className="mono">{sourceData?.branch ?? "loading…"}</td>
                  </tr>
                  <tr>
                    <th>observed</th>
                    <td className="mono">{shortSha(sourceData?.lastObservedSha)}</td>
                    <th>handled</th>
                    <td className="mono">{shortSha(sourceData?.lastHandledSha)}</td>
                  </tr>
                  <tr>
                    <th>trigger</th>
                    <td>GitHub push webhook</td>
                    <th>target</th>
                    <td>golden workspace images</td>
                  </tr>
                </>
              ) : (
                <tr>
                  <th>error</th>
                  <td
                    colSpan={3}
                    className="state-note"
                    role="alert"
                    style={{ color: "var(--st-error)" }}
                  >
                    {sourceError}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="state-note" style={{ margin: 0 }}>
          GitHub Actions publishes control-plane release images and golden workspace images. This
          deployed control plane listens for signed GitHub push webhooks, records expected golden
          tags, verifies those tags in ECR, then rolls the catalog when every configured variant is
          present.
        </p>
      </section>

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
              {imagesData === null && <LoadingRow colSpan={6} label="loading images…" />}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Source triggers</h2>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>status</th>
                <th>decision</th>
                <th>commit</th>
                <th>target</th>
                <th>tag</th>
                <th>build</th>
                <th>trigger</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {(sourceData?.triggers ?? []).map((t) => (
                <tr key={t.id}>
                  <td style={{ color: statusColor(t.status) }}>{t.status}</td>
                  <td>{t.decision}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {shortSha(t.afterSha)}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {t.target ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {t.tag ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {t.buildId?.split(":").pop() ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {t.triggeredBy}
                  </td>
                  <td>{t.reason}</td>
                </tr>
              ))}
              {sourceData === null && <LoadingRow colSpan={8} label="loading source triggers…" />}
            </tbody>
          </table>
        </div>
      </section>
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
