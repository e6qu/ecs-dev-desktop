// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { EDITOR_KINDS } from "./editor";
import {
  DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR,
  defaultResourcesForEditor,
  isValidWorkspaceResourcePair,
} from "./workspace-resources";

describe("per-editor default resources", () => {
  it("defines a default for every editor kind, and each is a valid Fargate pair", () => {
    for (const editor of EDITOR_KINDS) {
      const rec = defaultResourcesForEditor(editor);
      expect(rec).toBe(DEFAULT_WORKSPACE_RESOURCES_BY_EDITOR[editor]);
      expect(isValidWorkspaceResourcePair(rec)).toBe(true);
    }
  });

  it("right-sizes the heavy editors above the light ones", () => {
    // Terminal/monaco are light (a shell / lightweight editor); openvscode (full VS Code
    // server + language servers) and opencode (agent + tooling) need more than 2 GiB.
    expect(defaultResourcesForEditor("terminal")).toMatchObject({ cpuUnits: 512, memoryMiB: 2048 });
    expect(defaultResourcesForEditor("monaco")).toMatchObject({ cpuUnits: 512, memoryMiB: 2048 });
    expect(defaultResourcesForEditor("openvscode")).toMatchObject({
      cpuUnits: 1024,
      memoryMiB: 4096,
    });
    expect(defaultResourcesForEditor("opencode")).toMatchObject({
      cpuUnits: 1024,
      memoryMiB: 4096,
    });
  });
});
