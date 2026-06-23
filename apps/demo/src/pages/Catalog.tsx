// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

import { baseImage } from "@edd/core";

import { useDemo } from "../lib/use-demo";

export function Catalog(): JSX.Element {
  const cp = useDemo();
  const navigate = useNavigate();

  return (
    <section className="demo-page">
      <h2>Base-image catalog</h2>
      <p className="demo-fine">Curated golden images. Launch one to create a workspace from it.</p>
      <div className="demo-catalog">
        {cp.catalog().map((c) => (
          <div key={c.id} className="demo-card">
            <div className="demo-card-head">
              <h3>{c.name}</h3>
              <code className="meta">{c.image}</code>
            </div>
            <p className="demo-card-desc">{c.description}</p>
            <div className="demo-tools">
              {c.tools.map((t) => (
                <span key={t} className="demo-chip">
                  {t}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="demo-primary"
              onClick={() => {
                cp.create(baseImage(c.image));
                void navigate("/");
              }}
            >
              + New workspace
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
