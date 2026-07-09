// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the initial demo state by replaying REAL @edd/core lifecycle transitions over
// backdated timestamps — so the workspaces, the append-only audit ledger, and everything
// derived from them (cost windows, timelines, the audit feed) are authentic, not hand-faked.
import {
  baseImage,
  baseImageId,
  isoTimestamp,
  markProvisioned,
  markStopped,
  markTaskLost,
  markWaking,
  ownerId,
  provision,
  provisionBaseImage,
  snapshotId,
  taskId,
  unwrap,
  volumeId,
  workspaceId,
  type AuditEvent,
  type BaseImageEntry,
  type IsoTimestamp,
  type Workspace,
} from "@edd/core";

import {
  STATE_VERSION,
  type AgentKind,
  type DemoState,
  type DemoUser,
  type EditorKind,
  type SshKeyEntry,
} from "./demo-types";

const DAY_MS = 86_400_000;
const daysAgo = (d: number): IsoTimestamp =>
  isoTimestamp(new Date(Date.now() - d * DAY_MS).toISOString());

const USERS: readonly DemoUser[] = [
  { id: "ada", name: "Ada Okafor", email: "ada@edd.demo", role: "admin" },
  { id: "milo", name: "Milo Tan", email: "milo@edd.demo", role: "developer" },
  { id: "vera", name: "Vera Smit", email: "vera@edd.demo", role: "viewer" },
];

// Inert demo public keys (public keys are not secrets; only the public half is ever held). The
// settings page registers/removes more, validating the type with the real @edd/core `sshKeyType`.
const SEED_SSH_KEYS: readonly SshKeyEntry[] = [
  {
    id: "key-ada-1",
    ownerId: "ada",
    label: "ada laptop",
    keyType: "ssh-ed25519",
    publicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4kLpQh2mD3vR8tN0wXyZ7cF1bG6aE9sJ5oP2qU3rT demo-ada@edd.local",
    addedAt: daysAgo(40),
  },
  {
    id: "key-milo-1",
    ownerId: "milo",
    label: "milo workstation",
    keyType: "ssh-ed25519",
    publicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIQ9wE2rT5yU7iO0pA3sD6fG8hJ1kL4zX7cV0bN2mQ5w demo-milo@edd.local",
    addedAt: daysAgo(30),
  },
];

const IMAGES: readonly { ref: string; name: string; description: string; tools: string[] }[] = [
  {
    ref: "golden/omnibus",
    name: "Omnibus (all languages)",
    description: "Full polyglot workspace with every curated language toolchain and agent.",
    tools: ["node", "python", "go", "java", "rust"],
  },
  {
    ref: "golden/typescript",
    name: "TypeScript / Node",
    description: "Lean Node and TypeScript environment for app and tooling work.",
    tools: ["node", "pnpm", "tsc"],
  },
  {
    ref: "golden/python",
    name: "Python",
    description: "Python runtime with the repo's lint, type, and security tools baked in.",
    tools: ["python", "ruff", "mypy"],
  },
  {
    ref: "golden/go",
    name: "Go",
    description: "Go workspace with the static analysis set used in CI.",
    tools: ["go", "staticcheck"],
  },
  {
    ref: "golden/java",
    name: "Java",
    description: "JDK workspace with build tooling and the standard formatter.",
    tools: ["jdk", "maven"],
  },
  {
    ref: "golden/rust",
    name: "Rust",
    description: "Rust toolchain with linting and dependency-audit coverage.",
    tools: ["cargo", "clippy"],
  },
];

function seedCatalog(): BaseImageEntry[] {
  return IMAGES.map((img, i) =>
    provisionBaseImage({
      id: baseImageId(`img-${String(i + 1)}`),
      name: img.name,
      image: baseImage(img.ref),
      description: img.description,
      tools: img.tools,
      tags: ["golden"],
      at: daysAgo(60),
    }),
  );
}

interface SeededWorkspace {
  workspace: Workspace;
  events: AuditEvent[];
}

function audit(
  at: IsoTimestamp,
  owner: DemoUser,
  action: string,
  target: string,
  detail: string,
): AuditEvent {
  return { at, actor: owner.email, action, target, detail };
}

type LifecycleStep = "stop" | "wake" | "fail";

/** Provision at `createdDaysAgo`, then apply each step as a later real transition, accumulating
 * the domain object + a backdated audit trail (the `session.*` vocabulary the cost model bills). */
function buildWorkspace(opts: {
  owner: DemoUser;
  image: BaseImageEntry;
  index: number;
  createdDaysAgo: number;
  steps: LifecycleStep[];
}): SeededWorkspace {
  const id = `ws-${opts.owner.id}-${String(opts.index)}`;
  const createdAt = daysAgo(opts.createdDaysAgo);
  let ws = provision({
    id: workspaceId(id),
    ownerId: ownerId(opts.owner.id),
    baseImage: opts.image.image,
    volumeId: volumeId(`vol-${id}`),
    taskId: taskId(`task-${id}`),
    at: createdAt,
  });
  const events: AuditEvent[] = [
    audit(createdAt, opts.owner, "session.create", id, `created ${opts.image.name}`),
  ];

  let elapsed = opts.createdDaysAgo;
  for (const step of opts.steps) {
    elapsed = Math.max(0, elapsed - 1 - (opts.index % 3));
    const at = daysAgo(elapsed);
    if (step === "stop") {
      ws = unwrap(markStopped(ws, { id: snapshotId(`snap-${id}-${String(elapsed)}`), at }, at));
      events.push(audit(at, opts.owner, "session.stop", id, "scaled to zero (snapshot taken)"));
    } else if (step === "wake") {
      ws = unwrap(markWaking(ws, at)); // stopped → provisioning
      ws = unwrap(
        markProvisioned(
          ws,
          volumeId(`vol-${id}-${String(elapsed)}`),
          taskId(`task-${id}-${String(elapsed)}`),
          at,
        ),
      ); // provisioning → running
      events.push(audit(at, opts.owner, "session.start", id, "woken from snapshot"));
    } else {
      ws = unwrap(markTaskLost(ws, at)); // running, no snapshot → error
      events.push(
        audit(at, opts.owner, "session.error", id, "task lost with no snapshot — unrecoverable"),
      );
    }
  }
  return { workspace: ws, events };
}

export function buildSeed(): DemoState {
  const catalog = seedCatalog();
  const img = (i: number): BaseImageEntry => {
    const entry = catalog[i % catalog.length];
    if (entry === undefined) throw new Error("seed catalog is empty");
    return entry;
  };
  const byRole = (role: DemoUser["role"]): DemoUser => {
    const u = USERS.find((x) => x.role === role);
    if (u === undefined) throw new Error(`no seed user with role ${role}`);
    return u;
  };
  const ada = byRole("admin");
  const milo = byRole("developer");
  const vera = byRole("viewer");

  type Spec = Parameters<typeof buildWorkspace>[0] & { editor: EditorKind; agent: AgentKind };
  const specs: Spec[] = [
    {
      owner: ada,
      image: img(0),
      index: 1,
      createdDaysAgo: 28,
      steps: ["stop", "wake"],
      editor: "openvscode",
      agent: "claude-code",
    },
    {
      owner: ada,
      image: img(3),
      index: 2,
      createdDaysAgo: 21,
      steps: [],
      editor: "monaco",
      agent: "codex",
    },
    {
      owner: milo,
      image: img(1),
      index: 1,
      createdDaysAgo: 18,
      steps: ["stop"],
      editor: "openvscode",
      agent: "claude-code",
    },
    {
      owner: milo,
      image: img(2),
      index: 2,
      createdDaysAgo: 14,
      steps: ["stop", "wake", "stop"],
      editor: "monaco",
      agent: "codex",
    },
    {
      owner: milo,
      image: img(5),
      index: 3,
      createdDaysAgo: 9,
      steps: [],
      editor: "openvscode",
      agent: "claude-code",
    },
    {
      owner: vera,
      image: img(4),
      index: 1,
      createdDaysAgo: 7,
      steps: ["fail"],
      editor: "monaco",
      agent: "claude-code",
    },
    {
      owner: vera,
      image: img(1),
      index: 2,
      createdDaysAgo: 4,
      steps: [],
      editor: "openvscode",
      agent: "codex",
    },
    {
      owner: ada,
      image: img(0),
      index: 3,
      createdDaysAgo: 2,
      steps: ["stop"],
      editor: "monaco",
      agent: "claude-code",
    },
  ];

  const built = specs.map((s) => ({ ...buildWorkspace(s), editor: s.editor, agent: s.agent }));
  const editors: Record<string, EditorKind> = {};
  const agents: Record<string, AgentKind> = {};
  for (const b of built) {
    editors[b.workspace.id] = b.editor;
    agents[b.workspace.id] = b.agent;
  }

  return {
    version: STATE_VERSION,
    users: USERS,
    currentUserId: milo.id,
    catalog,
    workspaces: built.map((b) => b.workspace),
    editors,
    agents,
    sshKeys: SEED_SSH_KEYS,
    audit: built.flatMap((b) => b.events).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  };
}
