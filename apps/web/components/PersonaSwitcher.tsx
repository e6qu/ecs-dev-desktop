// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { personasFor, type Role } from "@edd/authz";
import { useTransition } from "react";

import { setPersonaAction } from "../app/actions";
import { TESTID } from "../lib/testids";

/**
 * "View as" persona switcher in the topbar user menu: lets a caller preview the
 * app at a role at or below their real one (a downgrade-only override, clamped
 * server-side in {@link setPersonaAction} — this component only ever offers
 * choices already at or below `realRole`, but the server never trusts that).
 * Hidden entirely for a real viewer (nothing lower to switch to).
 */
export function PersonaSwitcher({ role, realRole }: { role: Role; realRole: Role }) {
  const [pending, startTransition] = useTransition();
  const options = personasFor(realRole);
  if (options.length <= 1) return null;

  return (
    <select
      className="select"
      aria-label="view as"
      data-testid={TESTID.personaSwitcher}
      data-role={role}
      data-real-role={realRole}
      value={role}
      disabled={pending}
      onChange={(e) => {
        const persona = e.target.value;
        const formData = new FormData();
        formData.set("persona", persona);
        startTransition(() => {
          void setPersonaAction(formData);
        });
      }}
    >
      {options.map((r) => (
        <option key={r} value={r}>
          view as {r}
        </option>
      ))}
    </select>
  );
}
