// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

const panelStyle = { maxWidth: 560, margin: "56px auto", textAlign: "center" as const };
const kicker = { color: "var(--accent)", letterSpacing: "0.2em", fontSize: 11 } as const;

export default function SignedOutPage() {
  return (
    <section className="panel" style={panelStyle} aria-labelledby="signed-out-heading">
      <div className="mono" style={kicker}>
        SESSION ENDED
      </div>
      <h1 id="signed-out-heading" style={{ fontSize: 26, marginTop: 10 }}>
        You are signed out
      </h1>
      <p style={{ color: "var(--dim)", marginTop: 8 }}>
        Shauth ended the shared sign-in session and notified every connected application. Opening
        ECS Dev Desktop again requires a new sign-in.
      </p>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 24,
        }}
      >
        <Link className="btn primary" href="/login/shauth">
          Sign in again
        </Link>
        <Link className="btn" href="/login">
          Other sign-in options
        </Link>
      </div>
    </section>
  );
}
