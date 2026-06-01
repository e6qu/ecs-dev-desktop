// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

export function CreateWorkspace({ images }: { images: readonly string[] }) {
  const router = useRouter();
  const [image, setImage] = useState(images[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.createWorkspace({ baseImage: image });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <select
        className="select"
        value={image}
        onChange={(e) => {
          setImage(e.target.value);
        }}
      >
        {images.map((img) => (
          <option key={img} value={img}>
            {img}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn primary"
        disabled={busy}
        onClick={() => {
          void create();
        }}
      >
        {busy ? "provisioning…" : "+ new workspace"}
      </button>
      {error !== null && (
        <span className="mono" style={{ color: "var(--st-error)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
