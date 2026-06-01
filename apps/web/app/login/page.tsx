// SPDX-License-Identifier: AGPL-3.0-or-later
import { signIn } from "../../auth";

export default function LoginPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <form
        action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/" });
        }}
      >
        <button type="submit">Sign in with GitHub</button>
      </form>
      <form
        action={async () => {
          "use server";
          await signIn("microsoft-entra-id", { redirectTo: "/" });
        }}
      >
        <button type="submit">Sign in with Microsoft Entra</button>
      </form>
    </main>
  );
}
