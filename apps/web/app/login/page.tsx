// SPDX-License-Identifier: AGPL-3.0-or-later
import { signIn } from "../../auth";

export default function LoginPage() {
  return (
    <div className="panel" style={{ maxWidth: 440, margin: "56px auto", textAlign: "center" }}>
      <div
        className="mono"
        style={{ color: "var(--accent)", letterSpacing: "0.2em", fontSize: 11 }}
      >
        ACCESS
      </div>
      <h1 style={{ fontSize: 26, marginTop: 10 }}>Sign in</h1>
      <p style={{ color: "var(--dim)", marginTop: 8 }}>
        Authenticate with your identity provider to reach the control plane.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/workspaces" });
          }}
        >
          <button className="btn" type="submit" style={{ width: "100%" }}>
            Continue with GitHub
          </button>
        </form>
        <form
          action={async () => {
            "use server";
            await signIn("microsoft-entra-id", { redirectTo: "/workspaces" });
          }}
        >
          <button className="btn" type="submit" style={{ width: "100%" }}>
            Continue with Microsoft Entra
          </button>
        </form>
      </div>
    </div>
  );
}
