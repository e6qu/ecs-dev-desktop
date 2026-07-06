// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { WorkspaceDto } from "@edd/api-contracts";
import { useState } from "react";

import { TESTID } from "../lib/testids";

/** Bytes → a short human GiB figure (one decimal). */
export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The ⓘ control on a workspace card: a closeable overlay with the session's
 * settings — image, interface, sizing, disk usage, repo, timestamps. Pure client
 * presentation over the already-enriched DTO (no extra fetches).
 */
export function WorkspaceInfo({ ws }: { ws: WorkspaceDto }) {
  const [open, setOpen] = useState(false);
  const rows: [string, string][] = [
    ["image", ws.baseImage],
    ...(ws.imageName !== undefined ? ([["name", ws.imageName]] as [string, string][]) : []),
    ["interface", ws.editor ?? "openvscode"],
    ...(ws.resources !== undefined
      ? ([
          ["cpu", `${String(ws.resources.vcpu)} vCPU`],
          ["memory", `${String(ws.resources.memoryGib)} GiB`],
          ["disk", `${String(ws.resources.volumeGib)} GiB volume`],
        ] as [string, string][])
      : []),
    ...(ws.diskUsedBytes !== undefined && ws.diskTotalBytes !== undefined
      ? ([["disk used", `${gib(ws.diskUsedBytes)} of ${gib(ws.diskTotalBytes)}`]] as [
          string,
          string,
        ][])
      : []),
    ...(ws.repoUrl !== undefined ? ([["repository", ws.repoUrl]] as [string, string][]) : []),
    ...(ws.imageTools !== undefined && ws.imageTools.length > 0
      ? ([["tools", ws.imageTools.join(" · ")]] as [string, string][])
      : []),
    ["created", new Date(ws.createdAt).toLocaleString()],
  ];

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="help-toggle"
        aria-label={open ? "Close session details" : "Session details"}
        aria-expanded={open}
        data-testid={TESTID.workspaceInfoToggle}
        title="Session details"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Session details"
          data-testid={TESTID.workspaceInfoPanel}
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            zIndex: 30,
            minWidth: 280,
            maxWidth: 360,
            background: "var(--panel, #1c1f1a)",
            border: "1px solid var(--line, #333)",
            borderRadius: 8,
            padding: "10px 12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          <button
            type="button"
            className="help-panel-close"
            aria-label="Close session details"
            onClick={() => {
              setOpen(false);
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
          <dl
            style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px" }}
          >
            {rows.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt className="mono" style={{ color: "var(--dim)", fontSize: 11 }}>
                  {label}
                </dt>
                <dd className="mono" style={{ margin: 0, fontSize: 12, wordBreak: "break-all" }}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </span>
  );
}
