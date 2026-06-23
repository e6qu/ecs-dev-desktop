// SPDX-License-Identifier: AGPL-3.0-or-later
// Scripted agent transcripts for the demo (no backend). The terminal + chat panels render the
// SAME events, so both surfaces stay consistent. The opt-in real BYO-key mode (a follow-up
// slice) produces the same event shape from live API output.
import type { AgentKind } from "./demo-types";

export type AgentEvent =
  | { kind: "user"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; name: string; detail: string; result?: string }
  | { kind: "say"; text: string };

/** The primary source file in a workspace (first non-doc), for the script to reference. */
function primaryFile(fileNames: readonly string[]): string {
  return fileNames.find((f) => !f.toLowerCase().endsWith(".md")) ?? fileNames[0] ?? "main";
}

/** A believable opening session: the agent adds input validation + a test to the main file. */
export function scriptFor(_agent: AgentKind, fileNames: readonly string[]): AgentEvent[] {
  const file = primaryFile(fileNames);
  return [
    { kind: "user", text: `Add input validation to ${file} and a quick test.` },
    {
      kind: "think",
      text: "Reading the current code to see the entry point and existing patterns.",
    },
    { kind: "tool", name: "Read", detail: file, result: `${file} (1 file, ~30 lines)` },
    { kind: "think", text: "I'll guard the entry point against empty input and add a small test." },
    {
      kind: "tool",
      name: "Edit",
      detail: file,
      result: "+12 -1 — added a guard clause + an early return on empty input",
    },
    {
      kind: "tool",
      name: "Write",
      detail: `${file.replace(/\.[^.]+$/, "")}_test`,
      result: "new file (+18)",
    },
    { kind: "tool", name: "Bash", detail: "run the tests", result: "ok — 1 passed" },
    {
      kind: "say",
      text: `Done. Added an empty-input guard to ${file} and a passing test. Want me to wire it into CI next?`,
    },
  ];
}

/** A templated reply to a typed prompt (keyword-driven; the scripted-mode input box). */
export function respondTo(
  _agent: AgentKind,
  prompt: string,
  fileNames: readonly string[],
): AgentEvent[] {
  const file = primaryFile(fileNames);
  const p = prompt.toLowerCase();
  if (p.includes("test")) {
    return [
      { kind: "user", text: prompt },
      { kind: "think", text: "Scanning for an entry point to cover." },
      { kind: "tool", name: "Bash", detail: "run the tests", result: "ok — all green" },
      {
        kind: "say",
        text: "Tests pass. (Scripted demo — enable your own API key for a live run.)",
      },
    ];
  }
  if (p.includes("fix") || p.includes("bug") || p.includes("error")) {
    return [
      { kind: "user", text: prompt },
      { kind: "tool", name: "Read", detail: file },
      { kind: "tool", name: "Edit", detail: file, result: "+4 -2 — handled the failing case" },
      {
        kind: "say",
        text: `Patched ${file}. (Scripted demo — enable your own API key for a live run.)`,
      },
    ];
  }
  return [
    { kind: "user", text: prompt },
    {
      kind: "say",
      text: `Here's how I'd approach that in ${file}. (Scripted demo — add your own API key to run the real agent.)`,
    },
  ];
}
