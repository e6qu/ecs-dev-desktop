// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point the manual `e2e-aws` tier runs (`.github/workflows/e2e-aws.yml`):
// the EBS snapshot round-trip against REAL AWS, where it certifies the real
// snapshot-completion latency no simulator can model.
//
// Coordinates, not targets (AGENTS.md §6.9): it builds the client from the ambient
// env and honours `AWS_ENDPOINT_URL` if set, so the SAME round-trip logic
// (`runEbsSmoke`) is exercised against the sockerless sim by the storage integ tier
// (`ebs-smoke.integ.ts`) and against real AWS here — by coordinates alone.
import { EC2Client } from "@aws-sdk/client-ec2";
import { runEbsSmoke } from "@edd/storage-ec2";

const region = process.env.AWS_REGION;
if (region === undefined || region === "") throw new Error("AWS_REGION is required");
const endpoint =
  process.env.AWS_ENDPOINT_URL !== undefined && process.env.AWS_ENDPOINT_URL !== ""
    ? process.env.AWS_ENDPOINT_URL
    : undefined;
const prefix = process.env.EDD_E2E_AWS_PREFIX ?? "edd-e2eaws-local";

const ec2 = new EC2Client({ region, ...(endpoint === undefined ? {} : { endpoint }) });
const result = await runEbsSmoke(ec2, prefix);
console.log(
  `OK: EBS snapshot round-trip — restored ${result.restoredVolumeId} from ${result.snapshotId} ` +
    `(snapshot completion latency ${String(result.snapshotLatencyMs)} ms)`,
);
