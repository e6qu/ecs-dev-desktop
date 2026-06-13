// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAssertion } from "./pomerium-assertion";

const HOST = "ws-abc.devbox.localhost";

let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let otherPair: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  keyPair = await generateKeyPair("ES256");
  otherPair = await generateKeyPair("ES256");
});

/** Mint a Pomerium-shaped assertion (ES256) with the given overrides. */
async function mint(
  overrides: {
    aud?: string;
    iss?: string;
    sub?: string;
    email?: string;
    groups?: string[];
    expSeconds?: number;
  } = {},
): Promise<string> {
  let jwt = new SignJWT({
    email: overrides.email ?? "owner@edd.test",
    groups: overrides.groups ?? [],
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setIssuer(overrides.iss ?? HOST)
    .setAudience(overrides.aud ?? HOST)
    .setSubject(overrides.sub ?? "user-1")
    .setIssuedAt();
  jwt = jwt.setExpirationTime(`${String(overrides.expSeconds ?? 300)}s`);
  return jwt.sign(keyPair.privateKey);
}

describe("verifyAssertion", () => {
  it("accepts a valid assertion and returns the trusted identity", async () => {
    const token = await mint({ email: "Owner@EDD.test", groups: ["g-admin"] });
    const id = await verifyAssertion(token, HOST, keyPair.publicKey);
    expect(id.subject).toBe("user-1");
    expect(id.email).toBe("Owner@EDD.test");
    expect(id.groups).toEqual(["g-admin"]);
  });

  it("accepts the URI issuer format (https://host/)", async () => {
    const token = await mint({ iss: `https://${HOST}/` });
    await expect(verifyAssertion(token, HOST, keyPair.publicKey)).resolves.toBeDefined();
  });

  it("rejects a token signed by a different key (forgery)", async () => {
    const token = await mint();
    await expect(verifyAssertion(token, HOST, otherPair.publicKey)).rejects.toThrow();
  });

  it("rejects a token whose aud is a different workspace host (replay)", async () => {
    const token = await mint({ aud: "ws-other.devbox.localhost" });
    await expect(verifyAssertion(token, HOST, keyPair.publicKey)).rejects.toThrow();
  });

  it("rejects a token whose iss does not match the host", async () => {
    const token = await mint({ iss: "evil.example" });
    await expect(verifyAssertion(token, HOST, keyPair.publicKey)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ email: "owner@edd.test", groups: [] })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(HOST)
      .setAudience(HOST)
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keyPair.privateKey);
    await expect(verifyAssertion(token, HOST, keyPair.publicKey)).rejects.toThrow();
  });

  it("rejects a token with no subject", async () => {
    const token = await new SignJWT({ email: "owner@edd.test", groups: [] })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(HOST)
      .setAudience(HOST)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyPair.privateKey);
    await expect(verifyAssertion(token, HOST, keyPair.publicKey)).rejects.toThrow(/sub/);
  });

  it("tolerates a missing email claim (returns undefined)", async () => {
    const token = await new SignJWT({ groups: [] })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(HOST)
      .setAudience(HOST)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keyPair.privateKey);
    const id = await verifyAssertion(token, HOST, keyPair.publicKey);
    expect(id.email).toBeUndefined();
  });
});
