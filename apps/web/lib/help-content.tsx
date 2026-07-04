// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

import Link from "next/link";

/**
 * Per-page help content, keyed by route prefix. The HelpToggle component in the
 * topbar reads the current pathname and renders the matching entry. Written for
 * the people who use the platform — not developers. No invented jargon; acronyms
 * are defined on first use.
 */

function H({ children }: { children: ReactNode }) {
  return <p className="help-p">{children}</p>;
}

function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="help-link">
      {children}
    </Link>
  );
}

function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="help-section">
      <h2 className="help-h2">{title}</h2>
      {children}
    </div>
  );
}

/** A workspace is a personal cloud development environment. */
const workspacesHelp = (
  <>
    <H>
      A <strong>workspace</strong> is your personal development environment running in the cloud.
      Each workspace gives you a full editor (VS Code in the browser) and a terminal, connected to
      its own dedicated disk. You can install packages, write code, and run servers — just like a
      local machine, but accessible from anywhere.
    </H>
    <HelpSection title="States">
      <H>
        <span className="help-state running">● running</span> — the workspace is live and ready to
        use. Click <strong>Open</strong> to launch the editor.
      </H>
      <H>
        <span className="help-state idle">● idle</span> — the workspace is live but has not received
        any activity for a while. It will be stopped automatically soon.
      </H>
      <H>
        <span className="help-state stopped">● stopped</span> — the workspace has been shut down to
        save resources. Your files are preserved in a snapshot. Click <strong>Start</strong> to
        resume; it takes a few seconds to wake up.
      </H>
      <H>
        <span className="help-state error">● error</span> — something went wrong. The system will
        try to recover automatically. If it persists, contact an administrator.
      </H>
    </HelpSection>
    <HelpSection title="What you can do">
      <H>
        <strong>Start a new workspace</strong> — click <em>+ new session</em> to choose an
        environment and optional code repository. See{" "}
        <HelpLink href="/sessions/new?help=1">New session</HelpLink>.
      </H>
      <H>
        <strong>Open the editor</strong> — when a workspace is running or stopped, click{" "}
        <strong>Open</strong> to launch VS Code in your browser. A stopped workspace wakes up
        automatically when you connect.
      </H>
      <H>
        <strong>Connect via SSH</strong> — use the SSH (Secure Shell) command shown on each card to
        connect a local terminal or editor to the workspace. You need to{" "}
        <HelpLink href="/settings/ssh-keys?help=1">register an SSH key</HelpLink> first.
      </H>
      <H>
        <strong>Stop / Delete</strong> — <em>Stop</em> shuts the workspace down but keeps your
        files. <em>Delete</em> removes everything (after a confirmation step).
      </H>
    </HelpSection>
    <H>
      Workspaces that are left idle are automatically stopped to save resources — your work is
      always preserved. See <HelpLink href="/help/scale-to-zero">how auto-stop works</HelpLink>.
    </H>
  </>
);

const newSessionHelp = (
  <>
    <H>
      This page lets you create a new workspace. You pick a base environment (the tools and runtimes
      it comes with) and optionally connect a code repository to clone into it.
    </H>
    <HelpSection title="Choosing an environment">
      <H>
        Each <strong>environment</strong> is a pre-built template with a specific set of tools
        installed — for example, one might include Node.js and TypeScript, another might include Go
        and Python. Pick the one that matches what you want to build.
      </H>
      <H>
        Tags like <em>typescript</em> or <em>python</em> help you find the right environment. Tools
        like <em>pnpm</em> or <em>go</em> are already installed and ready to use.
      </H>
    </HelpSection>
    <HelpSection title="Connecting a repository (optional)">
      <H>
        If you connect a <strong>repository</strong> (a code repo hosted on GitHub or a similar
        service), it will be cloned into your workspace automatically when it starts. You can also
        skip this and start with a blank workspace.
      </H>
      <H>
        Repositories marked <em>private</em> require that your account has access. The connection
        uses your registered credentials — see{" "}
        <HelpLink href="/settings/ssh-keys?help=1">SSH keys</HelpLink>.
      </H>
    </HelpSection>
  </>
);

const sshKeysHelp = (
  <>
    <H>
      <strong>SSH</strong> (Secure Shell) is a protocol for securely connecting to a remote
      computer. To connect a terminal or editor on your local machine to a workspace, you need to
      register an SSH <strong>public key</strong> here.
    </H>
    <HelpSection title="How it works">
      <H>
        An SSH key pair has two files: a <em>public key</em> (which you paste here) and a{" "}
        <em>private key</em> (which stays on your computer). The workspace checks that your private
        key matches the public key you registered before allowing a connection.
      </H>
    </HelpSection>
    <HelpSection title="Adding a key">
      <H>
        Paste the entire contents of your public key file (usually{" "}
        <code>~/.ssh/id_ed25519.pub</code> or <code>~/.ssh/id_rsa.pub</code>) into the text area and
        click <strong>register key</strong>. The key should start with <code>ssh-ed25519</code>,{" "}
        <code>ssh-rsa</code>, or <code>ecdsa-sha2</code>.
      </H>
      <H>
        To generate a new key pair, run this in your terminal:
        <br />
        <code className="help-code">ssh-keygen -t ed25519 -C "your-email@example.com"</code>
      </H>
    </HelpSection>
    <HelpSection title="Connecting to a workspace">
      <H>
        Once you have a key registered, each workspace card on the{" "}
        <HelpLink href="/workspaces?help=1">workspaces page</HelpLink> shows an SSH command you can
        copy and paste into your terminal.
      </H>
    </HelpSection>
  </>
);

const loginHelp = (
  <>
    <H>
      Sign in to access your workspaces. Depending on how your organization has configured the
      platform, you can sign in with GitHub or with a Microsoft Entra ID (formerly Azure Active
      Directory) account.
    </H>
    <H>
      Your role (viewer, member, or administrator) is determined by your organization's group
      membership and controls what you can see and do.
    </H>
  </>
);

const overviewHelp = (
  <>
    <H>
      This page gives a quick summary of the entire fleet — how many workspaces exist, what states
      they are in, and what base images are available.
    </H>
    <HelpSection title="The numbers">
      <H>
        <strong>Total workspaces</strong> — every workspace across all users.
      </H>
      <H>
        <strong>By state</strong> — how many are running, stopped, or in an error state right now.
      </H>
      <H>
        <strong>Base images</strong> — the number of environment templates available for users to
        launch from. See <HelpLink href="/admin/catalog?help=1">Catalog</HelpLink>.
      </H>
    </HelpSection>
  </>
);

const healthHelp = (
  <>
    <H>
      This page shows whether each part of the system is healthy. Each row checks a different
      component and reports <span className="help-state ok">● ok</span>,{" "}
      <span className="help-state unknown">● unknown</span>, or{" "}
      <span className="help-state error">● degraded</span>.
    </H>
    <HelpSection title="What the checks mean">
      <H>
        <strong>Compute</strong> — whether workspaces can be launched (the ECS cluster is reachable
        and accepting tasks).
      </H>
      <H>
        <strong>Storage</strong> — whether disk volumes and snapshots can be created and restored.
      </H>
      <H>
        <strong>Database</strong> — whether the control-plane state store is reachable.
      </H>
      <H>
        <strong>Reconciler</strong> — whether the background maintenance loop (which stops idle
        workspaces and cleans up orphaned resources) is running on schedule.
      </H>
    </HelpSection>
    <HelpSection title="When something shows degraded">
      <H>
        A <span className="help-state error">degraded</span> status means that component is not
        responding as expected. Workspaces may fail to start or stop correctly until it recovers. If
        the issue persists, investigate the <HelpLink href="/admin/logs?help=1">logs</HelpLink> or
        check the cloud provider's status.
      </H>
    </HelpSection>
  </>
);

const infrastructureHelp = (
  <>
    <H>
      This page shows the cloud resources that the platform is running on — the ECS (Elastic
      Container Service) cluster, its capacity, and how the components connect.
    </H>
    <HelpSection title="What you see here">
      <H>
        <strong>Cluster stats</strong> — how many tasks are running, pending, or active in the
        container cluster.
      </H>
      <H>
        <strong>Topology</strong> — a diagram of how the load balancer, control plane, and workspace
        tasks relate to each other, with health status on each node.
      </H>
      <H>
        <strong>Configuration sync</strong> — whether the live cloud state matches what the platform
        expects (drift detection). If something shows <em>drift</em>, a resource was changed out of
        band and may need attention.
      </H>
    </HelpSection>
  </>
);

const adminWorkspacesHelp = (
  <>
    <H>
      This page lists every workspace across all users. Use it to find a specific workspace, check
      its state, or investigate issues.
    </H>
    <HelpSection title="What you can do">
      <H>
        <strong>Filter</strong> — by owner, state, or image.
      </H>
      <H>
        <strong>Inspect</strong> — click any workspace to see its full details, lifecycle history,
        tags, and resource bindings.
      </H>
      <H>
        <strong>Act</strong> — stop, start, snapshot, or delete any workspace (the same actions the
        owner has, but across all users).
      </H>
    </HelpSection>
  </>
);

const workspaceDetailHelp = (
  <>
    <H>
      This page shows the full details of a single workspace — its configuration, resource bindings,
      and lifecycle history.
    </H>
    <HelpSection title="Sections">
      <H>
        <strong>Details</strong> — owner, base image, current state, creation time, and the cloud
        resources (task, volume, snapshot) bound to it.
      </H>
      <H>
        <strong>Tags</strong> — the metadata tags applied to the workspace's cloud resources. The{" "}
        <code>edd:managed</code> tag marks resources that the platform created and controls.
      </H>
      <H>
        <strong>Timeline</strong> — a chronological log of every state transition (created, started,
        stopped, snapshotted, etc.) with timestamps.
      </H>
    </HelpSection>
  </>
);

const catalogHelp = (
  <>
    <H>
      This page manages the <strong>catalog</strong> — the list of base images (environment
      templates) that users can choose from when creating a new workspace.
    </H>
    <HelpSection title="What you can do">
      <H>
        <strong>Add a base image</strong> — register a container image from your registry as a
        launchable environment. Give it a name, description, and tags so users can find it.
      </H>
      <H>
        <strong>Enable / Disable</strong> — disabled images are hidden from the new-session picker
        but remain available to workspaces already using them.
      </H>
      <H>
        <strong>Delete</strong> — removes the image from the catalog. Existing workspaces are not
        affected (they keep running on the image they were launched with).
      </H>
    </HelpSection>
    <HelpSection title="Choosing an editor">
      <H>
        Each image can specify which editor it serves: <em>OpenVSCode</em> (the default, a full VS
        Code experience in the browser) or <em>Monaco</em> (a lighter code editor for simpler
        environments).
      </H>
    </HelpSection>
  </>
);

const costsHelp = (
  <>
    <H>
      This page shows how much the platform is spending, broken down by user and by session. Use it
      to understand where cloud costs are accumulating.
    </H>
    <HelpSection title="What the numbers mean">
      <H>
        <strong>Compute</strong> — the cost of the container tasks running workspaces, charged while
        a workspace is in a <em>running</em> state.
      </H>
      <H>
        <strong>Storage</strong> — the cost of the disk volumes and snapshots that hold workspace
        data, charged even when a workspace is stopped (the data is preserved).
      </H>
      <H>
        <strong>Total</strong> — compute + storage, for the selected time window.
      </H>
    </HelpSection>
    <HelpSection title="Time windows">
      <H>
        Use the window selector (7 days, 30 days, etc.) to focus on a specific period. The bars show
        each user's (or session's) proportional share of the total spend.
      </H>
    </HelpSection>
    <HelpSection title="Keeping costs down">
      <H>
        Workspaces that are left idle are automatically stopped — see{" "}
        <HelpLink href="/help/scale-to-zero">how auto-stop works</HelpLink>. The biggest cost lever
        is the number of <em>stopped</em> workspaces, each of which still pays for its disk storage.
      </H>
    </HelpSection>
  </>
);

const logsHelp = (
  <>
    <H>
      This page shows two kinds of information: an <strong>audit feed</strong> (what actions have
      been taken across the platform) and <strong>log streams</strong> (the real-time output from
      running services and workspaces).
    </H>
    <HelpSection title="Audit feed">
      <H>
        The audit feed records every significant action: workspace created, started, stopped,
        deleted; SSH key registered; base image added. Each entry shows who did it, when, and what
        workspace it affected.
      </H>
    </HelpSection>
    <HelpSection title="Log streams">
      <H>
        Log streams show the real-time text output from the control plane, the reconciler (the
        background maintenance loop), and individual workspaces. Use these to diagnose errors or
        investigate behaviour.
      </H>
      <H>
        You can filter by workspace using the <code>?workspaceId=</code> query parameter in the URL.
      </H>
    </HelpSection>
  </>
);

const quotasHelp = (
  <>
    <H>
      This page shows the workspace limits for each role and how much each user is currently using.
      Use it to see who is at or over their limit.
    </H>
    <HelpSection title="How limits work">
      <H>
        Each role (viewer, member, administrator) has a maximum number of workspaces a single user
        can own. The default limits are:
      </H>
      <H>
        <strong>Viewers</strong> — 0 (cannot create workspaces, but can be given access to existing
        ones).
      </H>
      <H>
        <strong>Members</strong> — a configurable number (default 5).
      </H>
      <H>
        <strong>Administrators</strong> — unlimited.
      </H>
    </HelpSection>
    <HelpSection title="When someone is at their limit">
      <H>
        A user at their limit cannot create new workspaces until they delete an existing one. The{" "}
        <em>at limit</em> flag highlights these users so you can decide whether to adjust the limit
        or ask them to clean up unused workspaces.
      </H>
    </HelpSection>
  </>
);

const scaleToZeroHelp = (
  <>
    <H>
      <strong>Auto-stop</strong> (sometimes called scale-to-zero) is the feature that automatically
      shuts down workspaces when they are not being used, to save cloud resources.
    </H>
    <HelpSection title="How it works">
      <H>
        Every workspace runs a small background agent that sends a regular{" "}
        <strong>heartbeat</strong> (a "I'm still here" signal) to the control plane. If no heartbeat
        is received for a certain period (the <strong>idle threshold</strong>, typically 30
        minutes), the workspace is automatically stopped.
      </H>
      <H>
        When a workspace is stopped, its disk contents are saved as a <strong>snapshot</strong> (a
        point-in-time copy). The workspace can be resumed from the snapshot at any time — your files
        and installed packages are preserved.
      </H>
    </HelpSection>
    <HelpSection title="Waking up">
      <H>
        When you connect to a stopped workspace (via the <strong>Open</strong> button or SSH), it
        automatically wakes up. This takes a few seconds while the disk is restored from the
        snapshot and the container starts.
      </H>
    </HelpSection>
    <HelpSection title="Scheduled snapshots">
      <H>
        Even while a workspace is running, periodic snapshots are taken automatically (every 6 hours
        by default). New workspaces get snapshots more frequently (every 10 minutes for the first
        hour) to protect recent work.
      </H>
    </HelpSection>
  </>
);

/**
 * Route-prefix → help-content mapping. The HelpToggle matches the longest prefix.
 * Order matters: longer/more-specific routes must come first.
 */
const HELP_MAP: { match: string; content: ReactNode }[] = [
  { match: "/admin/workspaces/", content: workspaceDetailHelp },
  { match: "/admin/overview", content: overviewHelp },
  { match: "/admin/health", content: healthHelp },
  { match: "/admin/infrastructure", content: infrastructureHelp },
  { match: "/admin/workspaces", content: adminWorkspacesHelp },
  { match: "/admin/catalog", content: catalogHelp },
  { match: "/admin/costs", content: costsHelp },
  { match: "/admin/logs", content: logsHelp },
  { match: "/admin/quotas", content: quotasHelp },
  { match: "/sessions/new", content: newSessionHelp },
  { match: "/settings/ssh-keys", content: sshKeysHelp },
  { match: "/workspaces", content: workspacesHelp },
  { match: "/login", content: loginHelp },
];

/** Special routes outside the main app tree. */
const HELP_SPECIAL: { match: string; content: ReactNode }[] = [
  { match: "/help/scale-to-zero", content: scaleToZeroHelp },
];

/** Find the help content for a pathname, or null if none. */
export function findHelp(pathname: string): ReactNode {
  for (const entry of HELP_SPECIAL) {
    if (pathname === entry.match) return entry.content;
  }
  for (const entry of HELP_MAP) {
    if (pathname.startsWith(entry.match)) return entry.content;
  }
  return null;
}
