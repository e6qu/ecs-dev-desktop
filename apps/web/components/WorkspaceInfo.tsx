// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { WorkspaceDto } from "@edd/api-contracts";
import { useState } from "react";

import { gib } from "../lib/format";
import { TESTID } from "../lib/testids";

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
    ...(ws.snapshotIntervalMs !== undefined
      ? ([["snapshot interval", `${String(Math.round(ws.snapshotIntervalMs / 60000))} min`]] as [
          string,
          string,
        ][])
      : []),
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
        // Full-page modal (fixed, over everything) rather than a card-relative
        // dropdown: the old absolutely-positioned panel overflowed and shoved the
        // card layout around. A backdrop click OR the prominent × closes it.
        <div
          role="presentation"
          onClick={() => {
            setOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Session details"
            data-testid={TESTID.workspaceInfoPanel}
            onClick={(e) => {
              e.stopPropagation();
            }}
            style={{
              position: "relative",
              width: "min(96vw, 560px)",
              maxHeight: "85vh",
              overflowY: "auto",
              background: "var(--panel, #1c1f1a)",
              border: "1px solid var(--line, #333)",
              borderRadius: 12,
              padding: "20px 22px 22px",
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 16 }}>Session details</h2>
              <button
                type="button"
                aria-label="Close session details"
                data-testid={TESTID.workspaceInfoClose}
                onClick={() => {
                  setOpen(false);
                }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: "1px solid var(--line, #333)",
                  background: "transparent",
                  color: "var(--fg, #e6e6e6)",
                  fontSize: 22,
                  lineHeight: "1",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr)",
                gap: "10px 14px",
              }}
            >
              {rows.map(([label, value]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
                    {label}
                  </dt>
                  <dd
                    className="mono"
                    style={{ margin: 0, fontSize: 13, lineHeight: 1.5, wordBreak: "break-all" }}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </span>
  );
}
