// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { EditorKindDto } from "@edd/api-contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

export function CreateBaseImage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [tools, setTools] = useState("");
  const [editor, setEditor] = useState<EditorKindDto>("openvscode");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseLabels(value: string): string[] | undefined {
    const labels = value
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== "");
    return labels.length === 0 ? undefined : labels;
  }

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.createBaseImage({
        name: name.trim(),
        image: image.trim(),
        description: description.trim() === "" ? undefined : description.trim(),
        tags: parseLabels(tags),
        tools: parseLabels(tools),
        editor,
      });
      setName("");
      setImage("");
      setDescription("");
      setTags("");
      setTools("");
      setEditor("openvscode");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  const ready = name.trim() !== "" && image.trim() !== "" && !busy;

  return (
    <div className="panel">
      <form
        id="create-base-image-form"
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void add();
        }}
      >
        <label className="field-stack">
          <span className="field-label">Display name</span>
          <input
            className="input"
            placeholder="Node 20 (Debian)"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="field-stack">
          <span className="field-label">Image ref</span>
          <input
            className="input"
            placeholder="golden/node:20"
            value={image}
            onChange={(e) => {
              setImage(e.target.value);
            }}
          />
        </label>
        <label className="field-stack field-span-2">
          <span className="field-label">Description</span>
          <input
            className="input"
            placeholder="Short operator-facing summary of the workspace environment"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
        </label>
        <label className="field-stack">
          <span className="field-label">Tags</span>
          <input
            className="input"
            placeholder="typescript, slim, lts"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
            }}
          />
          <span className="field-hint">Comma-separated facets shown in the picker.</span>
        </label>
        <label className="field-stack">
          <span className="field-label">Tools</span>
          <input
            className="input"
            placeholder="pnpm, eslint, trivy"
            value={tools}
            onChange={(e) => {
              setTools(e.target.value);
            }}
          />
          <span className="field-hint">Key CLIs surfaced to users before launch.</span>
        </label>
        <label className="field-stack">
          <span className="field-label">Editor</span>
          <select
            className="input"
            value={editor}
            onChange={(e) => {
              if (e.target.value === "openvscode" || e.target.value === "monaco") {
                setEditor(e.target.value);
              }
            }}
          >
            <option value="openvscode">OpenVSCode</option>
            <option value="monaco">Monaco</option>
          </select>
          <span className="field-hint">Which editor workspaces from this image serve.</span>
        </label>
      </form>
      <div className="field" style={{ marginTop: 16 }}>
        <button
          type="submit"
          form="create-base-image-form"
          className="btn primary"
          disabled={!ready}
          onClick={() => {
            void add();
          }}
        >
          {busy ? "adding…" : "+ add base image"}
        </button>
        {error !== null && (
          <span role="alert" className="mono" style={{ color: "var(--st-error)" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
