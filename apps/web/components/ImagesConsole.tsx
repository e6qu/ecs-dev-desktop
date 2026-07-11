// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type {
  ImageBuildRecordDto,
  ImageSourceStateDto,
  ImageMetadataDto,
} from "@edd/api-contracts";
import { useCallback, useState } from "react";

import { humanBytes } from "../lib/format";
import { usePoll } from "../lib/usePoll";

type ImageEntry = ImageMetadataDto | { repo: string; tag: null };

const SOURCE_POLL_MS = 5000;
const IMAGES_POLL_MS = 30_000;

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

/** A build's wall-clock duration as `m:ss`, or "—" while still running (no end yet). */
function buildDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  const totalSec = Math.round(durationMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min.toString()}:${sec.toString().padStart(2, "0")}`;
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

/** The admin Images console: per-image size + layer breakdown, the golden-image
 * source-sync state, and build history from BOTH builders — GitHub Actions webhook
 * triggers AND AWS CodeBuild builds (via /api/admin/builds). This console observes
 * builds; it does not start them (POST /api/admin/builds deliberately answers 410). */
export function ImagesConsole() {
  const loadImages = useCallback(
    () => fetch("/api/admin/images").then((r) => jsonOrThrow<{ images: ImageEntry[] }>(r)),
    [],
  );
  const loadSource = useCallback(
    () => fetch("/api/admin/image-source").then((r) => jsonOrThrow<ImageSourceStateDto>(r)),
    [],
  );
  const loadBuilds = useCallback(
    () => fetch("/api/admin/builds").then((r) => jsonOrThrow<{ builds: ImageBuildRecordDto[] }>(r)),
    [],
  );
  const { data: imagesData, error: imagesError } = usePoll(
    loadImages,
    IMAGES_POLL_MS,
    "images unavailable",
  );
  const { data: sourceData, error: sourceError } = usePoll(
    loadSource,
    SOURCE_POLL_MS,
    "image source unavailable",
  );
  const { data: buildsData, error: buildsError } = usePoll(
    loadBuilds,
    SOURCE_POLL_MS,
    "build history unavailable",
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
              {/* A failed images fetch must be visible (§6.5), never a silently
                  empty table; rows already loaded stay as last-known state. */}
              {imagesError !== null && (
                <tr>
                  <td
                    colSpan={6}
                    className="state-note"
                    role="alert"
                    style={{ color: "var(--st-error)" }}
                  >
                    {imagesError}
                  </td>
                </tr>
              )}
              {imagesError === null && imagesData === null && (
                <LoadingRow colSpan={6} label="loading images…" />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>GitHub Actions builds (source triggers)</h2>
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
        <p className="state-note" style={{ margin: 0 }}>
          These builds run in <strong>GitHub Actions</strong> (webhook-driven on push). Builds run
          via <strong>AWS CodeBuild</strong> — e.g. the terraform-apply bootstrap build — are
          tracked separately below.
        </p>
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>CodeBuild builds</h2>
        <div className="table-scroll" style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>status</th>
                <th>target</th>
                <th>tag</th>
                <th>ref</th>
                <th>started</th>
                <th>duration</th>
                <th>build</th>
                <th>by</th>
              </tr>
            </thead>
            <tbody>
              {(buildsData?.builds ?? []).map((b) => (
                <tr key={b.buildId}>
                  <td style={{ color: statusColor(b.status) }}>
                    {b.status}
                    {b.phase !== undefined ? ` · ${b.phase.toLowerCase()}` : ""}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.target}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.tag}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {shortSha(b.ref)}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(b.startedAt).toLocaleString()}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {buildDuration(b.durationMs)}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.buildId.split(":").pop() ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {b.triggeredBy}
                  </td>
                </tr>
              ))}
              {buildsError !== null && (
                <tr>
                  <td
                    colSpan={8}
                    className="state-note"
                    role="alert"
                    style={{ color: "var(--st-error)" }}
                  >
                    {buildsError}
                  </td>
                </tr>
              )}
              {buildsError === null && buildsData === null && (
                <LoadingRow colSpan={8} label="loading CodeBuild builds…" />
              )}
              {buildsError === null && buildsData?.builds.length === 0 && (
                <tr>
                  <td colSpan={8} className="state-note">
                    no CodeBuild builds recorded (this project may build only via GitHub Actions)
                  </td>
                </tr>
              )}
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
