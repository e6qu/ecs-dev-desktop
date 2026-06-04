// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

export function CreateBaseImage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.createBaseImage({
        name,
        image,
        description: description === "" ? undefined : description,
      });
      setName("");
      setImage("");
      setDescription("");
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
      <div className="field">
        <input
          className="input"
          placeholder="display name — e.g. Node 20 (Debian)"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <input
          className="input"
          placeholder="image ref — e.g. golden/node:20"
          value={image}
          onChange={(e) => {
            setImage(e.target.value);
          }}
        />
        <input
          className="input"
          placeholder="description (optional)"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!ready}
          onClick={() => {
            void add();
          }}
        >
          {busy ? "adding…" : "+ add base image"}
        </button>
        {error !== null && (
          <span className="mono" style={{ color: "var(--st-error)" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
