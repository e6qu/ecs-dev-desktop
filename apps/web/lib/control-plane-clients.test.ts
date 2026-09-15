// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The factories whose calls are counted. Every real one resolves credentials and
// opens connections, so the control plane must call each once per process, not
// once per request.
const createDynamoClient = vi.fn(() => ({ send: vi.fn() }));
const ec2FromEnv = vi.fn(() => ({ health: vi.fn() }));
const ecsFromEnv = vi.fn(() => ({ health: vi.fn(), clusterInfo: vi.fn() }));
const cloudTrailFromEnv = vi.fn(() => ({ recent: vi.fn() }));
const metricReaderFromEnv = vi.fn(() => ({ read: vi.fn() }));
const logSourceFromEnv = vi.fn(() => ({ read: vi.fn() }));

vi.mock("@edd/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@edd/db")>()),
  createDynamoClient,
  pingTable: vi.fn(() => Promise.resolve({ component: "dynamodb", status: "ok", detail: "stub" })),
}));
vi.mock("@edd/storage-ec2", () => ({ Ec2StorageProvider: { fromEnv: ec2FromEnv } }));
vi.mock("@edd/compute-ecs", () => ({ EcsComputeProvider: { fromEnv: ecsFromEnv } }));
vi.mock("@edd/cloudtrail-audit", () => ({ CloudTrailAuditSource: { fromEnv: cloudTrailFromEnv } }));
vi.mock("@edd/cloudwatch-logs", () => ({ CloudWatchLogSource: { fromEnv: logSourceFromEnv } }));
vi.mock("@edd/cloudwatch-metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@edd/cloudwatch-metrics")>()),
  CloudWatchMetricReader: { fromEnv: metricReaderFromEnv },
}));

const ENV = {
  COMPUTE_PROVIDER: "ecs",
  AUDIT_PROVIDER: "cloudtrail",
  LOG_PROVIDER: "cloudwatch",
  EDD_APP_NAME: "edd-unit",
  EDD_AGENT_SECRET: "a".repeat(64),
  EDD_CONNECTION_SECRET: "b".repeat(64),
  DYNAMODB_TABLE: "edd-unit",
};

describe("control-plane wiring builds AWS clients once per process", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reuses the providers, the DynamoDB client and the observability sources across calls", async () => {
    const cp = await import("./control-plane");
    for (let i = 0; i < 3; i++) {
      await cp.getHealthService();
      await cp.checkReadiness();
      cp.getAuditSource();
      cp.getMetricReader();
      cp.getLogSource();
    }
    expect(ec2FromEnv).toHaveBeenCalledTimes(1);
    expect(ecsFromEnv).toHaveBeenCalledTimes(1);
    expect(cloudTrailFromEnv).toHaveBeenCalledTimes(1);
    expect(metricReaderFromEnv).toHaveBeenCalledTimes(1);
    expect(logSourceFromEnv).toHaveBeenCalledTimes(1);
    expect(createDynamoClient).toHaveBeenCalledTimes(1);
  });
});
