// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signCert } from "./ssh-cert";

describe("signCert", () => {
  let caDir: string;
  let caKey: string;
  let userDir: string;
  let userKey: string;

  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), "edd-test-ca-"));
    caKey = join(caDir, "ca");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", caKey, "-C", "test-ca"]);

    userDir = mkdtempSync(join(tmpdir(), "edd-test-user-"));
    userKey = join(userDir, "id");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", userKey, "-C", "test-user"]);
  });

  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("returns a valid OpenSSH certificate", () => {
    const pubKey = readFileSync(`${userKey}.pub`, "utf8").trim();
    const cert = signCert(caKey, pubKey, "dev-test", "test-identity");
    expect(cert).toMatch(/^ssh-ed25519-cert-v01@openssh\.com /);
  });

  it("embeds the requested principal", () => {
    const pubKey = readFileSync(`${userKey}.pub`, "utf8").trim();
    const cert = signCert(caKey, pubKey, "dev-myworkspace", "test-identity");

    // Write cert to a temp file and inspect it with ssh-keygen -L.
    const certFile = join(userDir, "inspect-cert.pub");
    writeFileSync(certFile, cert);
    const inspect = spawnSync("ssh-keygen", ["-L", "-f", certFile], { encoding: "utf8" });
    expect(inspect.stdout).toContain("dev-myworkspace");
  });

  it("throws when the CA key path is invalid", () => {
    expect(() => signCert("/no/such/key", "ssh-ed25519 AAAA", "dev-x", "id")).toThrow();
  });
});
