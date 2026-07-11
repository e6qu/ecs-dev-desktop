// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { TrafficFilterStateDto } from "@edd/api-contracts";
// Import from the pure traffic-filter subpath (not the `@edd/core` barrel): the barrel
// re-exports server-only modules (e.g. FakeStorageProvider → node:fs), which cannot be
// bundled into this client component. The subpath is the same source the server uses.
import {
  compileTrafficFilter,
  EMPTY_TRAFFIC_FILTER_POLICY,
  validateTrafficFilterPolicy,
  type CompiledRule,
  type FilterMode,
  type TrafficFilterPolicy,
} from "@edd/core/system/traffic-filter";
import { useCallback, useEffect, useMemo, useState } from "react";

import { humanAgo, utcStamp } from "../lib/format";

/** Stable selectors shared with the Playwright spec. */
const TRAFFIC_TESTID = {
  mode: "traffic-mode",
  cidrs: "traffic-cidrs",
  countries: "traffic-countries",
  asns: "traffic-asns",
  blockAnon: "traffic-block-anon",
  preset: "traffic-preset",
  save: "traffic-save",
  defaultAction: "traffic-default-action",
  previewRule: "traffic-preview-rule",
  applied: "traffic-applied",
  loadError: "traffic-load-error",
  applyError: "traffic-apply-error",
} as const;

/** Parse a comma/whitespace/newline-separated list into trimmed, non-empty tokens. */
function tokenize(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/** The editable form fields as raw text (parsed to the policy on the fly). */
interface FormState {
  mode: FilterMode;
  cidrs: string;
  countries: string;
  asns: string;
  presets: readonly string[];
  blockAnonymous: boolean;
}

function formFromPolicy(policy: TrafficFilterPolicy): FormState {
  return {
    mode: policy.mode,
    cidrs: policy.cidrs.join("\n"),
    countries: policy.countries.join(", "),
    asns: policy.asns.join(", "),
    presets: policy.presets,
    blockAnonymous: policy.blockAnonymous,
  };
}

/** Build the policy from the raw form (ASNs parse to numbers; NaN entries dropped —
 * validation still flags out-of-range values on the parsed policy). */
function policyFromForm(form: FormState): TrafficFilterPolicy {
  return {
    version: 1,
    mode: form.mode,
    cidrs: tokenize(form.cidrs),
    countries: tokenize(form.countries).map((c) => c.toUpperCase()),
    asns: tokenize(form.asns).map((n) => Number(n)),
    presets: form.presets,
    blockAnonymous: form.blockAnonymous,
  };
}

function describeRule(rule: CompiledRule): string {
  switch (rule.kind) {
    case "ip":
      return `${rule.action} IP CIDRs: ${rule.cidrs.join(", ")}`;
    case "geo":
      return `${rule.action} countries: ${rule.countries.join(", ")}`;
    case "asn":
      return `${rule.action} ASNs: ${rule.asns.join(", ")}`;
    case "managed-anonymous":
      return "block anonymous sources (hosting/VPN/proxy/Tor)";
  }
}

/**
 * Admin traffic-filter console. Edits the allow/block policy (IP CIDRs, countries,
 * ASNs, cloud/hoster presets, block-anonymous), shows a LIVE preview of the compiled
 * WAF rules + default action (compiled client-side by the SAME `@edd/core`
 * `compileTrafficFilter` the server applies — no divergence), and saves via PUT. The
 * last apply time / apply error is surfaced loudly; load + apply failures are never
 * swallowed (§6.5).
 */
export function TrafficFilterConsole() {
  const [state, setState] = useState<TrafficFilterStateDto | null>(null);
  const [presets, setPresets] = useState<readonly string[]>([]);
  const [form, setForm] = useState<FormState>(formFromPolicy(EMPTY_TRAFFIC_FILTER_POLICY));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const mount = { live: true };
    async function load(): Promise<void> {
      try {
        const res = await fetch("/api/admin/traffic");
        if (!res.ok) throw new Error(`HTTP ${res.status.toString()}`);
        const body = (await res.json()) as TrafficFilterStateDto;
        if (!mount.live) return;
        setState(body);
        setPresets(body.presets);
        setForm(formFromPolicy(body.policy));
      } catch (e) {
        if (mount.live) setLoadError(e instanceof Error ? e.message : "traffic filter unavailable");
      }
    }
    void load();
    return () => {
      mount.live = false;
    };
  }, []);

  const policy = useMemo(() => policyFromForm(form), [form]);
  const issues = useMemo(() => validateTrafficFilterPolicy(policy), [policy]);
  // Compile the LIVE edited policy for the preview. Only compile when valid — the core
  // throws on an invalid policy (that is the fail-loud contract), so we guard with the
  // issue list and show the issues instead.
  const compiled = useMemo(
    () => (issues.length === 0 ? compileTrafficFilter(policy) : null),
    [policy, issues],
  );

  const togglePreset = useCallback((name: string) => {
    setForm((f) => ({
      ...f,
      presets: f.presets.includes(name)
        ? f.presets.filter((p) => p !== name)
        : [...f.presets, name],
    }));
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/admin/traffic", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policyFromForm(form)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status.toString()}`);
      }
      const body = (await res.json()) as TrafficFilterStateDto;
      setState(body);
      setPresets(body.presets);
      setForm(formFromPolicy(body.policy));
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "apply failed");
    } finally {
      setBusy(false);
    }
  }, [form]);

  const nowMs = Date.now();
  const appliedMs = state?.appliedAt !== undefined ? Date.parse(state.appliedAt) : null;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {loadError !== null && (
        <span
          className="state-note"
          role="alert"
          data-testid={TRAFFIC_TESTID.loadError}
          style={{ color: "var(--st-error)" }}
        >
          {loadError}
        </span>
      )}

      <div className="panel">
        <form
          id="traffic-filter-form"
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && issues.length === 0) void save();
          }}
        >
          <label className="field-stack">
            <span className="field-label">Mode</span>
            <select
              className="input"
              data-testid={TRAFFIC_TESTID.mode}
              value={form.mode}
              onChange={(e) => {
                const mode = e.target.value === "allow" ? "allow" : "block";
                setForm((f) => ({ ...f, mode }));
              }}
            >
              <option value="block">block listed (default allow)</option>
              <option value="allow">allow only listed (default deny)</option>
            </select>
            <span className="field-hint">
              {form.mode === "allow"
                ? "Only sources matching a rule may reach the app."
                : "Listed sources are denied; everything else is allowed."}
            </span>
          </label>

          <label className="field-stack">
            <span className="field-label">Block anonymous sources</span>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid={TRAFFIC_TESTID.blockAnon}
                checked={form.blockAnonymous}
                onChange={(e) => {
                  setForm((f) => ({ ...f, blockAnonymous: e.target.checked }));
                }}
              />
              <span className="field-hint" style={{ margin: 0 }}>
                Block hosting/VPN/proxy/Tor (AWS managed anonymous-IP list).
              </span>
            </span>
          </label>

          <label className="field-stack field-span-2">
            <span className="field-label">IP CIDRs</span>
            <textarea
              className="input"
              data-testid={TRAFFIC_TESTID.cidrs}
              rows={3}
              placeholder="203.0.113.0/24&#10;2001:db8::/32"
              value={form.cidrs}
              onChange={(e) => {
                setForm((f) => ({ ...f, cidrs: e.target.value }));
              }}
            />
            <span className="field-hint">One CIDR per line or comma-separated.</span>
          </label>

          <label className="field-stack">
            <span className="field-label">Countries (ISO alpha-2)</span>
            <input
              className="input"
              data-testid={TRAFFIC_TESTID.countries}
              placeholder="US, DE, GB"
              value={form.countries}
              onChange={(e) => {
                setForm((f) => ({ ...f, countries: e.target.value }));
              }}
            />
            <span className="field-hint">Two-letter codes, comma-separated.</span>
          </label>

          <label className="field-stack">
            <span className="field-label">ASNs</span>
            <input
              className="input"
              data-testid={TRAFFIC_TESTID.asns}
              placeholder="16509, 15169"
              value={form.asns}
              onChange={(e) => {
                setForm((f) => ({ ...f, asns: e.target.value }));
              }}
            />
            <span className="field-hint">Autonomous System Numbers, comma-separated.</span>
          </label>

          <div className="field-stack field-span-2">
            <span className="field-label">Cloud / hoster presets</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {presets.map((name) => (
                <label key={name} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    data-testid={`${TRAFFIC_TESTID.preset}-${name}`}
                    checked={form.presets.includes(name)}
                    onChange={() => {
                      togglePreset(name);
                    }}
                  />
                  <span>{name}</span>
                </label>
              ))}
              {presets.length === 0 && (
                <span className="field-hint" style={{ margin: 0 }}>
                  no presets available
                </span>
              )}
            </div>
            <span className="field-hint">Each preset expands to its owner ASNs.</span>
          </div>
        </form>

        <div className="field" style={{ marginTop: 16 }}>
          <button
            type="submit"
            form="traffic-filter-form"
            className="btn primary"
            data-testid={TRAFFIC_TESTID.save}
            disabled={busy || issues.length > 0}
          >
            {busy ? "applying…" : "Save & apply to WAF"}
          </button>
          {applyError !== null && (
            <span
              role="alert"
              className="mono"
              data-testid={TRAFFIC_TESTID.applyError}
              style={{ color: "var(--st-error)" }}
            >
              {applyError}
            </span>
          )}
        </div>

        {issues.length > 0 && (
          <ul
            className="state-note"
            role="alert"
            style={{ color: "var(--st-error)", marginTop: 8 }}
          >
            {issues.map((i) => (
              <li key={`${i.field}:${i.value}`}>
                {i.field} “{i.value}” — {i.reason}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="field-label">Compiled preview</div>
        <p className="state-note" style={{ marginTop: 4 }}>
          Default action:{" "}
          <strong data-testid={TRAFFIC_TESTID.defaultAction}>
            {compiled?.defaultAction ?? "—"}
          </strong>
        </p>
        {compiled === null ? (
          <p className="state-note">Fix the issues above to preview the compiled rules.</p>
        ) : compiled.rules.length === 0 ? (
          <p className="state-note">
            No rules — this policy is a no-op (all traffic follows the default action).
          </p>
        ) : (
          <ol className="stack" style={{ gap: 6, margin: 0, paddingLeft: 20 }}>
            {compiled.rules.map((rule, idx) => (
              <li
                key={`${rule.kind}-${idx.toString()}`}
                data-testid={TRAFFIC_TESTID.previewRule}
                data-kind={rule.kind}
                data-action={"action" in rule ? rule.action : "block"}
              >
                <span className={`pill ${rule.action === "allow" ? "on" : "off"}`}>
                  {rule.action}
                </span>{" "}
                {describeRule(rule)}
              </li>
            ))}
          </ol>
        )}
      </div>

      <p className="state-note" data-testid={TRAFFIC_TESTID.applied}>
        {state?.appliedError !== undefined ? (
          <span style={{ color: "var(--st-error)" }}>last apply FAILED: {state.appliedError}</span>
        ) : appliedMs !== null ? (
          <span title={utcStamp(appliedMs)}>
            last applied to the live WAF {humanAgo(appliedMs, nowMs)}
          </span>
        ) : (
          <span style={{ color: "var(--dim)" }}>never applied to the live WAF yet</span>
        )}
      </p>
    </div>
  );
}
