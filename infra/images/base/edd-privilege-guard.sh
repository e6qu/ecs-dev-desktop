#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Privilege guard. Installed on PATH (/usr/local/bin) UNDER the names of tools that
# need privileges this sandboxed workspace intentionally does not grant (docker, sudo,
# mount, …). It does NOT run the tool — the Fargate task is non-root + unprivileged, so
# the tool would fail anyway. Instead it: (1) tells the user clearly why, (2) emits a
# structured security line that ships to CloudWatch (→ the admin per-workspace log
# view), (3) best-effort reports the attempt to the control plane so it shows in admin
# monitoring/dashboards fleet-wide, then (4) exits non-zero. Belts & suspenders: the
# sandbox already blocks privilege; this makes the WHY visible and auditable.
set -eu

# The name we were invoked as (a symlink/wrapper per guarded tool) → which tool.
tool="$(basename -- "$0")"
user="$(id -un 2>/dev/null || echo unknown)"

# 1) Friendly, actionable message to the user (stderr — never stdout, so it can't
#    corrupt a tool that parses our output).
cat >&2 <<MSG
edd: '${tool}' is not available in this workspace.
This is a sandboxed, unprivileged environment (belts & suspenders): '${tool}' needs
privileges it intentionally does not grant. Use the platform's supported workflow if
you need containers or elevated tooling — running it here is blocked and recorded.
MSG

# 2) Structured security line (warn level) → CloudWatch workspace log group → admin
#    Logs view. No raw args (avoid log/JSON injection); the tool name is the signal.
printf '{"level":"warn","security":"privilege_attempt","tool":"%s","user":"%s"}\n' \
  "${tool}" "${user}" >&2

# 3) Best-effort report to the control plane (same agent machine-auth as the heartbeat)
#    so the attempt surfaces in admin monitoring + the security metric/alarm. Absent
#    wiring (a bare local run) → skip silently.
if [ -n "${EDD_CONTROL_PLANE_URL:-}" ] &&
  [ -n "${EDD_AGENT_TOKEN:-}" ] &&
  [ -n "${EDD_WORKSPACE_ID:-}" ]; then
  curl -sf -X POST \
    "${EDD_CONTROL_PLANE_URL}/api/workspaces/${EDD_WORKSPACE_ID}/security-event" \
    -H "Authorization: Bearer ${EDD_AGENT_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    -d "{\"kind\":\"privilege_attempt\",\"tool\":\"${tool}\"}" \
    -o /dev/null 2>/dev/null || true
fi

# 126 = "command found but cannot execute" (permission) — the conventional code.
exit 126
