// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { deriveWorkspaceToken } from "@edd/core";
import { describe, expect, it } from "vitest";

import { startIdeBridge, type IdeBridge } from "./ide-bridge";
import {
  createRunningWorkspace,
  initLiveEnv,
  newSecret,
  startEditorApp,
  WORKSPACE_IMAGE,
} from "./live-editor-fixture";

/**
 * Full live flow for the FIRST-PARTY MONACO editor: a base-image entry with editor=monaco makes
 * the control plane launch the task with EDD_EDITOR_MODE=monaco, so the container runs the bundled
 * @edd/editor-monaco server (not OpenVSCode). Reached through the IDE bridge, it must gate without
 * the connection token and serve the Monaco SPA with it — proving the editor choice all the way to
 * a real served editor on the container-mode sim. (The token rides CONNECTION_TOKEN env, not a
 * process arg, so the bridge skips OpenVSCode-style extraction and we derive it here.)
 */
initLiveEnv();

describe(
  "full live flow: a monaco-editor workspace serves the Monaco SPA",
  { timeout: 600_000 },
  () => {
    it("launches a monaco task and serves the Monaco editor (gated by the connection token)", async () => {
      const connectionSecret = newSecret();
      const app = await startEditorApp({
        runId: `monaco-${randomUUID().slice(0, 8)}`,
        vpcCidr: "10.81.0.0/16", // distinct CIDRs so concurrent suites never collide
        subnetCidr: "10.81.1.0/24",
        connectionSecret,
        editor: "monaco",
      });
      let bridge: IdeBridge | undefined;
      try {
        const ws = await createRunningWorkspace(app, "monaco-user");
        expect(ws.editor).toBe("monaco"); // the catalog editor choice flowed through

        // Bridge to :3000 in the task netns. The Monaco server validates CONNECTION_TOKEN itself,
        // so we skip OpenVSCode-style token extraction and derive the expected token.
        bridge = await startIdeBridge({
          workspaceId: ws.id,
          image: WORKSPACE_IMAGE,
          extractConnectionToken: false,
        });
        const token = deriveWorkspaceToken(connectionSecret, ws.id);
        const base = `http://127.0.0.1:${String(bridge.port)}/w/${ws.id}/`;

        // No token → the editor server gates the request (401), a real auth gate.
        expect((await fetch(base, { redirect: "manual" })).status).toBe(401);

        // With the token: 302 + Set-Cookie (the OpenVSCode-style handoff), then the SPA serves.
        const handoff = await fetch(`${base}?tkn=${token}`, { redirect: "manual" });
        expect(handoff.status).toBe(302);
        const cookie = (handoff.headers.get("set-cookie") ?? "").split(";")[0];
        const spa = await fetch(base, { headers: { cookie } });
        expect(spa.status).toBe(200);
        // The Monaco SPA shell (its file explorer) — distinct from the OpenVSCode workbench.
        expect(await spa.text()).toContain('id="sidebar"');
      } finally {
        bridge?.close();
        await app.stop();
      }
    });
  },
);
