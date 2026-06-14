// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { caKeyPath, signCert } from "./ssh-cert";

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

describe("caKeyPath", () => {
  const env = process.env;
  let savedPath: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedPath = env.EDD_SSH_CA_KEY_PATH;
    savedKey = env.EDD_SSH_CA_KEY;
    delete env.EDD_SSH_CA_KEY_PATH;
    delete env.EDD_SSH_CA_KEY;
  });
  afterEach(() => {
    if (savedPath === undefined) delete env.EDD_SSH_CA_KEY_PATH;
    else env.EDD_SSH_CA_KEY_PATH = savedPath;
    if (savedKey === undefined) delete env.EDD_SSH_CA_KEY;
    else env.EDD_SSH_CA_KEY = savedKey;
  });

  it("returns EDD_SSH_CA_KEY_PATH verbatim, and it wins over key material", () => {
    env.EDD_SSH_CA_KEY_PATH = "/etc/edd/ca";
    env.EDD_SSH_CA_KEY = "ignored-material";
    expect(caKeyPath()).toBe("/etc/edd/ca");
  });

  it("materializes EDD_SSH_CA_KEY to a file, ensuring a trailing newline", () => {
    const material = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    env.EDD_SSH_CA_KEY = material;
    expect(readFileSync(caKeyPath(), "utf8")).toBe(`${material}\n`);
  });

  it("preserves an existing trailing newline in the material", () => {
    env.EDD_SSH_CA_KEY = "key-with-newline\n";
    expect(readFileSync(caKeyPath(), "utf8")).toBe("key-with-newline\n");
  });

  it("throws loudly when neither coordinate is set", () => {
    expect(() => caKeyPath()).toThrow(/EDD_SSH_CA_KEY_PATH .* or EDD_SSH_CA_KEY/);
  });
});
