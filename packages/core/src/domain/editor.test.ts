// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { provisionBaseImage } from "./base-image-catalog";
import { asEditorKind, DEFAULT_EDITOR } from "./editor";
import {
  baseImage,
  baseImageId,
  isoTimestamp,
  ownerId,
  taskId,
  volumeId,
  workspaceId,
} from "./ids";
import { provision } from "./workspace";

const AT = isoTimestamp("2026-01-01T00:00:00.000Z");

describe("asEditorKind", () => {
  it("accepts known kinds and defaults only an omitted value", () => {
    expect(asEditorKind("openvscode")).toBe("openvscode");
    expect(asEditorKind("monaco")).toBe("monaco");
    expect(asEditorKind("terminal")).toBe("terminal");
    expect(asEditorKind("opencode")).toBe("opencode");
    expect(asEditorKind(undefined)).toBe(DEFAULT_EDITOR);
  });

  it("fails loudly on unknown editor values", () => {
    expect(() => asEditorKind("emacs")).toThrow("unknown editor kind: emacs");
    expect(() => asEditorKind(42)).toThrow("unknown editor kind: 42");
  });
});

describe("editor flows through the domain constructors", () => {
  it("a base image defaults to OpenVSCode and honors an explicit choice", () => {
    const base = { id: baseImageId("img-1"), name: "Go", image: baseImage("ecr/go"), at: AT };
    expect(provisionBaseImage(base).editor).toBe("openvscode");
    expect(provisionBaseImage({ ...base, editor: "monaco" }).editor).toBe("monaco");
    expect(provisionBaseImage({ ...base, editor: "terminal" }).editor).toBe("terminal");
    expect(provisionBaseImage({ ...base, editor: "opencode" }).editor).toBe("opencode");
  });

  it("a workspace records its editor (default OpenVSCode)", () => {
    const params = {
      id: workspaceId("ws-1"),
      ownerId: ownerId("u1"),
      baseImage: baseImage("ecr/go"),
      volumeId: volumeId("vol-1"),
      taskId: taskId("task-1"),
      at: AT,
    };
    expect(provision(params).editor).toBe("openvscode");
    expect(provision({ ...params, editor: "monaco" }).editor).toBe("monaco");
    expect(provision({ ...params, editor: "terminal" }).editor).toBe("terminal");
    expect(provision({ ...params, editor: "opencode" }).editor).toBe("opencode");
  });
});
