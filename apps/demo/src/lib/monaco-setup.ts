// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle Monaco + its language workers through Vite (the `?worker` imports) so the static demo
// is fully self-contained — no runtime CDN fetch. `loader.config({ monaco })` points
// @monaco-editor/react at this bundled instance instead of its default CDN loader.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
