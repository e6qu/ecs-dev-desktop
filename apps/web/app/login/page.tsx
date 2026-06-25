// SPDX-License-Identifier: AGPL-3.0-or-later
import { devUsers } from "@edd/config";

import { signIn } from "../../auth";
import { devAuthEnabled } from "../../lib/principal";
import { TESTID } from "../../lib/testids";
import { devSignIn } from "./actions";

const panelStyle = { maxWidth: 440, margin: "56px auto", textAlign: "center" as const };
const kicker = { color: "var(--accent)", letterSpacing: "0.2em", fontSize: 11 } as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return devAuthEnabled() ? <DevLogin error={error} /> : <OidcLogin />;
}

/** Local dev sign-in form (EDD_DEV_AUTH=1): a seeded account + password.
 * Accounts come from configuration (`EDD_DEV_USERS`, default set in @edd/config). */
function DevLogin({ error }: { error?: string }) {
  const users = devUsers();
  return (
    <div className="panel" style={panelStyle}>
      <div className="mono" style={kicker}>
        LOCAL DEV
      </div>
      <h1 style={{ fontSize: 26, marginTop: 10 }}>Sign in</h1>
      <p style={{ color: "var(--dim)", marginTop: 8 }}>
        Local dev-auth — seeded accounts. (Production uses GitHub / Microsoft Entra.)
      </p>
      {error !== undefined && (
        <p
          className="mono"
          data-testid={TESTID.loginError}
          style={{ color: "var(--st-error)", marginTop: 12, fontSize: 12 }}
        >
          Invalid username or password
        </p>
      )}
      <form
        action={devSignIn}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginTop: 24,
          textAlign: "left",
        }}
      >
        <label className="mono" style={{ fontSize: 12 }}>
          user
          <select
            name="username"
            defaultValue={users[0]?.username}
            data-testid={TESTID.loginUser}
            className="input"
            style={{ width: "100%" }}
          >
            {users.map((u) => (
              <option key={u.username} value={u.username}>
                {u.username} ({u.role})
              </option>
            ))}
          </select>
        </label>
        <label className="mono" style={{ fontSize: 12 }}>
          password
          <input
            name="password"
            type="password"
            autoComplete="off"
            data-testid={TESTID.loginPassword}
            placeholder="EDD_DEV_PASSWORD (default: dev)"
            className="input"
            style={{ width: "100%" }}
          />
        </label>
        <button
          className="btn primary"
          type="submit"
          data-testid={TESTID.loginSubmit}
          style={{ width: "100%", marginTop: 4 }}
        >
          Sign in
        </button>
      </form>
    </div>
  );
}

/** Production sign-in: identity providers. */
function OidcLogin() {
  return (
    <div className="panel" style={panelStyle}>
      <div className="mono" style={kicker}>
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
