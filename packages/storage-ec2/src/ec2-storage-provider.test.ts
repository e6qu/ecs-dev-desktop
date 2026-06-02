// SPDX-License-Identifier: AGPL-3.0-or-later
import { EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect, it } from "vitest";

import { Ec2StorageProvider } from "./index";

// Pure checks — no AWS calls (constructing a client does no I/O).
describe("Ec2StorageProvider (unit)", () => {
  const sp = new Ec2StorageProvider({ client: new EC2Client({ region: "us-east-1" }) });

  it("defers volume file I/O to the compute layer (sockerless #333)", () => {
    expect(() => sp.readFile()).toThrow(/compute/);
    expect(() => sp.writeFile()).toThrow(/compute/);
  });
});
