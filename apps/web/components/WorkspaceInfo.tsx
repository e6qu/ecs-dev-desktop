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
    <span className="workspace-info">
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
          className="help-overlay"
          role="presentation"
          onClick={() => {
            setOpen(false);
          }}
        >
          <div
            className="help-panel workspace-info-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Session details"
            data-testid={TESTID.workspaceInfoPanel}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="help-panel-header">
              <h2>Session details</h2>
              <button
                type="button"
                className="help-panel-close"
                aria-label="Close session details"
                data-testid={TESTID.workspaceInfoClose}
                onClick={() => {
                  setOpen(false);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <dl className="workspace-info-grid">
              {rows.map(([label, value]) => (
                <div key={label} className="workspace-info-row">
                  <dt className="mono">{label}</dt>
                  <dd className="mono">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </span>
  );
}
