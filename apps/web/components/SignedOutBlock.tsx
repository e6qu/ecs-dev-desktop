// SPDX-License-Identifier: AGPL-3.0-or-later
import { StateBlock } from "./StateBlock";

/** The shared "sign in first" gate for owner/viewer pages. */
export function SignedOutBlock({ detail }: { detail: string }) {
  return (
    <StateBlock
      title="Not signed in"
      detail={detail}
      action={{ href: "/login", label: "sign in" }}
    />
  );
}
