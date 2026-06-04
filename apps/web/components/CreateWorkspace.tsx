// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

/** An enabled catalog entry the user can launch a workspace from. */
export interface CatalogOption {
  name: string;
  image: string;
}

export function CreateWorkspace({ images }: { images: readonly CatalogOption[] }) {
  const router = useRouter();
  const [image, setImage] = useState(images[0]?.image ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (images.length === 0) {
    return (
      <span className="mono" style={{ color: "var(--dim)" }}>
        no base images in the catalog yet
      </span>
    );
  }

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
        {images.map((opt) => (
          <option key={opt.image} value={opt.image}>
            {opt.name}
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
