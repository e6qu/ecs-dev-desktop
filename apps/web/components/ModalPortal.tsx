// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Mount modal overlays at the document root so card/header transforms and
 * stacking contexts can never place them behind application content. */
export function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
