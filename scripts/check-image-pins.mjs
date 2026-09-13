#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Golden-image toolchain pins: are they on the newest release that has cleared
// the adoption quarantine?
//
// Every `ARG <TOOL>_VERSION=` in infra/images/*/Dockerfile exists because
// resolving "latest" at build time made the image depend on whatever upstream
// shipped that morning — two builds of one Dockerfile could differ, and an
// upstream release could break CI with no change in this repository, which it
// did on 2026-08-02 (google-java-format 1.36.0 moved to a Java 21 target under a
// Java 17 JDK). A pin that never moves has the opposite failure: it rots. This
// is the same 24-hour age-eligibility rule check-node-deps.mjs applies to npm
// packages, extended to every registry the images pull a toolchain from.
//
// Behaviour per pin:
//   current  — on the newest release that is at least ONE_DAY old
//   held     — behind only releases younger than ONE_DAY (quarantine; not drift)
//   behind   — an older-than-ONE_DAY release exists past the pin: DRIFT, fails
//
// VS Code extensions baked into the images (`--install-extension id@version`)
// are covered too, against Open VSX. An extension release is only a candidate
// when its `engines.vscode` range admits the pinned OPENVSCODE_VERSION: the
// newest ms-python.vscode-python-envs needs a newer editor than the image
// ships, and a gate that demanded it would be asking for a pin that cannot
// install. An extension listed without `@version` fails the gate outright.
//
// Registries are looked up read-only. A lookup that fails is reported and does
// not pass silently: an unreachable registry must not look like "current".

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const imagesDir = new URL("../infra/images/", import.meta.url).pathname;

/** Where each pin comes from, and how to ask that source for its releases with
 * publish times. `ghRelease` reads GitHub releases (tag + published_at); `npm`
 * reads the registry's `time` map; `pypi` reads release upload times; `crates`
 * reads crates.io versions; `goDev` and `gradle` have no per-release dates on
 * their version endpoints, so those two report only whether a newer release
 * exists and cannot apply the age rule. */
const SOURCES = {
  OPENVSCODE_VERSION: { kind: "ghRelease", repo: "gitpod-io/openvscode-server", strip: /^openvscode-server-v/ },
  TRIVY_VERSION: { kind: "ghRelease", repo: "aquasecurity/trivy", keepV: true },
  UV_VERSION: { kind: "ghRelease", repo: "astral-sh/uv" },
  BUN_VERSION: { kind: "ghRelease", repo: "oven-sh/bun", strip: /^bun-v/ },
  RUST_VERSION: { kind: "ghRelease", repo: "rust-lang/rust" },
  GOLANGCI_LINT_VERSION: { kind: "ghRelease", repo: "golangci/golangci-lint", keepV: true },
  STATICCHECK_VERSION: { kind: "goProxy", module: "honnef.co/go/tools", keepV: true },
  X_TOOLS_VERSION: { kind: "goProxy", module: "golang.org/x/tools", keepV: true },
  DUPL_VERSION: { kind: "goProxy", module: "github.com/mibk/dupl", keepV: true },
  CARGO_AUDIT_VERSION: { kind: "crates", crate: "cargo-audit" },
  // The image ships Yarn Classic; Yarn Berry is per-project via corepack and its
  // `yarn` npm package stopped at 2.4.3 in 2021, so only the 1.x line is tracked.
  YARN_VERSION: { kind: "npm", pkg: "yarn", track: /^1\./ },
  PNPM_VERSION: { kind: "npm", pkg: "pnpm" },
  TYPESCRIPT_VERSION: { kind: "npm", pkg: "typescript" },
  PLAYWRIGHT_VERSION: { kind: "npm", pkg: "playwright" },
  PRETTIER_VERSION: { kind: "npm", pkg: "prettier" },
  ESLINT_VERSION: { kind: "npm", pkg: "eslint" },
  KNIP_VERSION: { kind: "npm", pkg: "knip" },
  JSCPD_VERSION: { kind: "npm", pkg: "jscpd" },
  CLAUDE_CODE_VERSION: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
  CODEX_VERSION: { kind: "npm", pkg: "@openai/codex" },
  RUFF_VERSION: { kind: "pypi", pkg: "ruff" },
  TY_VERSION: { kind: "pypi", pkg: "ty" },
  VULTURE_VERSION: { kind: "pypi", pkg: "vulture" },
  BANDIT_VERSION: { kind: "pypi", pkg: "bandit" },
  SEMGREP_VERSION: { kind: "pypi", pkg: "semgrep" },
  GO_VERSION: { kind: "goDev" },
  GRADLE_VERSION: { kind: "gradle" },
  GJF_VERSION: { kind: "pinnedOnPurpose", why: "held to the newest release targeting the image's Java 17 JDK; see infra/images/java/Dockerfile" },
};

/** Does `version` satisfy a VS Code `engines.vscode` range? Extensions use the
 * npm range grammar's small subset: `^x.y.z`, `~x.y.z`, `>=x.y.z`, `*`, an exact
 * version, or space-separated comparators; `-prerelease` suffixes are ignored. */
function satisfiesEngine(version, range) {
  const v = numeric(version.replace(/-.*$/, "")).slice(0, 3);
  const lt = (a, b) => compare(a.join("."), b.join(".")) < 0;
  return range.trim().split(/\s*\|\|\s*/).some((alt) =>
    alt.trim().split(/\s+/).every((comp) => {
      if (comp === "*" || comp === "" || /^[xX]/.test(comp)) return true;
      const m = comp.match(/^(\^|~|>=|<=|>|<|=)?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?/);
      if (!m) return false;
      const op = m[1] ?? "";
      const base = [Number(m[2]), m[3] === undefined || m[3] === "x" ? 0 : Number(m[3]), m[4] === undefined || m[4] === "x" ? 0 : Number(m[4])];
      const upper = op === "^" ? (base[0] > 0 ? [base[0] + 1, 0, 0] : [0, base[1] + 1, 0])
        : op === "~" || m[3] === undefined || m[3] === "x" ? [base[0], base[1] + 1, 0]
        : m[4] === undefined || m[4] === "x" ? [base[0], base[1] + 1, 0] : null;
      switch (op) {
        case ">": return !lt(v, base) && compare(v.join("."), base.join(".")) !== 0;
        case ">=": return !lt(v, base);
        case "<": return lt(v, base);
        case "<=": return !lt(base, v);
        default: return !lt(v, base) && (upper === null ? compare(v.join("."), base.join(".")) === 0 : lt(v, upper));
      }
    }));
}

// Semver: anything after a hyphen is a prerelease or a build tag (`-rc.1`,
// `-win32-x64`); registries that don't use hyphens spell it out in the version.
const stable = (v) => !v.includes("-") && !/(rc|beta|alpha|pre|dev|next)/i.test(v);
const numeric = (v) => v.replace(/^v/, "").split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
function compare(a, b) {
  const x = numeric(a), y = numeric(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i] ?? 0, q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": "edd-check-image-pins", ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Returns [{version, publishedAt: ms|null}] newest-first, stable only. */
async function releases(src) {
  switch (src.kind) {
    case "ghRelease": {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      const rows = await getJson(`https://api.github.com/repos/${src.repo}/releases?per_page=40`,
        token ? { authorization: `Bearer ${token}` } : {});
      return rows
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({ tag: r.tag_name, publishedAt: Date.parse(r.published_at) }))
        .filter((r) => !src.tagOnly || src.tagOnly.test(r.tag))
        .map((r) => ({ version: src.keepV ? r.tag : r.tag.replace(src.strip ?? /^v/, ""), publishedAt: r.publishedAt }))
        .filter((r) => stable(r.version));
    }
    case "npm": {
      const d = await getJson(`https://registry.npmjs.org/${src.pkg}`);
      return Object.keys(d.versions ?? {}).filter(stable)
        .map((v) => ({ version: v, publishedAt: Date.parse(d.time?.[v] ?? "") || null }));
    }
    case "pypi": {
      const d = await getJson(`https://pypi.org/pypi/${src.pkg}/json`);
      return Object.entries(d.releases ?? {}).filter(([v, files]) => stable(v) && files.length > 0)
        .map(([v, files]) => ({ version: v, publishedAt: Math.max(...files.map((f) => Date.parse(f.upload_time_iso_8601))) }));
    }
    case "crates": {
      const d = await getJson(`https://crates.io/api/v1/crates/${src.crate}/versions`);
      return d.versions.filter((v) => !v.yanked && stable(v.num)).map((v) => ({ version: v.num, publishedAt: Date.parse(v.created_at) }));
    }
    case "goProxy": {
      const res = await fetch(`https://proxy.golang.org/${src.module}/@v/list`);
      const list = (await res.text()).split("\n").filter((v) => v && stable(v));
      const out = [];
      for (const v of list.sort(compare).slice(-6)) {
        const info = await getJson(`https://proxy.golang.org/${src.module}/@v/${v}.info`);
        out.push({ version: v, publishedAt: Date.parse(info.Time) });
      }
      return out;
    }
    case "openvsx": {
      // Newest-first, one row per (version, target platform). Some publishers
      // ship one universal build, others one per platform, and a few switched
      // mid-history, so the platforms the images run on are each asked and
      // merged. Pre-releases sit on top for extensions that publish nightlies,
      // so page until a stable, engine-compatible row has cleared the quarantine.
      const seen = new Set();
      const out = [];
      for (const platform of ["universal", "linux-x64", "linux-arm64"]) {
        const base = `https://open-vsx.org/api/-/query?extensionId=${src.id}&targetPlatform=${platform}&includeAllVersions=true&size=100`;
        let found = false;
        for (let offset = 0; !found; offset += 100) {
          const d = await getJson(`${base}&offset=${offset}`);
          for (const e of d.extensions ?? []) {
            if (seen.has(e.version)) continue;
            seen.add(e.version);
            if (e.preRelease || !satisfiesEngine(src.editor, e.engines?.vscode ?? "*")) continue;
            out.push({ version: e.version, publishedAt: Date.parse(e.timestamp) });
            if (now - e.publishedAt >= ONE_DAY_MS) found = true;
          }
          if (offset + 100 >= (d.totalSize ?? 0) || (d.extensions ?? []).length === 0) break;
        }
      }
      return out;
    }
    case "goDev": {
      const txt = await (await fetch("https://go.dev/VERSION?m=text")).text();
      return [{ version: txt.split("\n")[0].replace(/^go/, ""), publishedAt: null }];
    }
    case "gradle": {
      const d = await getJson("https://services.gradle.org/versions/current");
      return [{ version: d.version, publishedAt: null }];
    }
    default:
      return [];
  }
}

function readPins() {
  const pins = [];
  for (const dir of readdirSync(imagesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    let text;
    try { text = readFileSync(join(imagesDir, dir.name, "Dockerfile"), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/^ARG ([A-Z_]+_VERSION)=(\S+)/gm)) {
      pins.push({ image: dir.name, name: m[1], value: m[2] });
    }
    // Every RUN that installs extensions: a `for ext in a@1 b@2; do …` list or a
    // single `--install-extension id@version`. Local .vsix files are built here.
    for (const block of text.match(/^RUN(?:.*\\\n)*.*$/gm) ?? []) {
      if (!block.includes("--install-extension")) continue;
      for (const tok of block.split(/\s+/)) {
        if (tok.endsWith(".vsix")) continue;
        const m = tok.match(/^([a-z0-9-]+\.[a-z0-9-]+)(?:@(\d[\w.]*))?$/i);
        if (!m) continue;
        pins.push({ image: dir.name, name: `extension ${m[1]}`, value: m[2] ?? null, extension: m[1] });
      }
    }
  }
  return pins;
}

const pins = readPins();
const byName = new Map();
for (const p of pins) {
  const list = byName.get(p.name) ?? [];
  list.push(p);
  byName.set(p.name, list);
}

let drift = 0, failed = 0;
for (const [name, entries] of [...byName.entries()].sort()) {
  const src = entries[0].extension
    ? { kind: "openvsx", id: entries[0].extension, editor: byName.get("OPENVSCODE_VERSION")?.[0]?.value ?? "*" }
    : SOURCES[name];
  const values = [...new Set(entries.map((e) => e.value))].sort((a, b) => (a === null) - (b === null));
  const where = entries.map((e) => e.image).join(",");
  if (values.length > 1) {
    console.log(`  DRIFT  ${name}: pinned differently across images (${entries.map((e) => `${e.image}=${e.value}`).join(", ")})`);
    drift += 1;
    continue;
  }
  const pinned = values[0];
  if (pinned === null) {
    console.log(`  DRIFT  ${name} (${where}): installed without @version — resolved at build time`);
    drift += 1;
    continue;
  }
  if (src === undefined) {
    console.log(`  ::error::${name} (${where}): no registry source registered in scripts/check-image-pins.mjs`);
    failed += 1;
    continue;
  }
  if (src.kind === "pinnedOnPurpose") {
    console.log(`  HELD   ${name}=${pinned} (${where}): ${src.why}`);
    continue;
  }
  let rels;
  try {
    rels = (await releases(src))
      .filter((r) => !src.track || src.track.test(r.version))
      .sort((a, b) => compare(b.version, a.version));
  } catch (err) {
    console.log(`  ::error::${name} (${where}): could not read its registry — ${err.message}`);
    failed += 1;
    continue;
  }
  const newest = rels[0];
  if (newest === undefined) { console.log(`  ::error::${name}: registry returned no stable releases`); failed += 1; continue; }
  const eligible = rels.find((r) => r.publishedAt === null || now - r.publishedAt >= ONE_DAY_MS);
  if (compare(pinned, newest.version) > 0 && !rels.some((r) => r.version === pinned)) {
    // Ahead of every release the registry admits: a typo, a pre-release, or (for
    // an extension) a build that the pinned editor cannot load.
    console.log(`  DRIFT  ${name}=${pinned} (${where}): not a stable release the image can install — newest installable is ${newest.version}`);
    drift += 1;
  } else if (compare(pinned, newest.version) >= 0) {
    console.log(`  ok     ${name}=${pinned} (${where})`);
  } else if (eligible === undefined || compare(pinned, eligible.version) >= 0) {
    console.log(`  HELD   ${name}=${pinned} (${where}): ${newest.version} is inside the 24h quarantine`);
  } else {
    console.log(`  DRIFT  ${name}=${pinned} (${where}): latest age-eligible ${eligible.version} (newest ${newest.version})`);
    drift += 1;
  }
}

if (failed > 0) {
  console.error(`::error::${failed} image pin(s) could not be checked.`);
  process.exit(1);
}
if (drift > 0) {
  console.error(`::error::${drift} golden-image toolchain pin(s) behind the latest age-eligible release — bump the ARG in infra/images/*/Dockerfile.`);
  process.exit(1);
}
console.log(`All ${byName.size} golden-image toolchain pins are current or held.`);
