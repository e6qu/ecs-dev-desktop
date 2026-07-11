// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ECS adapter for the wake listener (imperative shell). A small port over the
 * two ECS operations the listener needs — read the control-plane service's
 * scale, and set its desired count — plus the real SDK adapter. The port is the
 * seam the handler is unit-tested against with a fake; the adapter reaches ECS
 * through the standard SDK, so the same code hits the sockerless sim or real AWS
 * by `AWS_ENDPOINT_URL` / `AWS_REGION` alone (AGENTS.md §6.9).
 */
import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { AWS_SDK_MAX_ATTEMPTS, AWS_SDK_RETRY_MODE, DEFAULT_AWS_REGION } from "@edd/config";

type Env = Readonly<Record<string, string | undefined>>;

/** The control-plane ECS service's current scale, read for a wake decision. */
export interface EcsServiceScale {
  readonly desiredCount: number;
  readonly runningCount: number;
}

/** Port over the ECS operations the wake listener performs. */
export interface EcsServicePort {
  /** Read the service's current desired + running counts. Fails loud if the
   * service is missing or the response omits the counts. */
  describe(input: { readonly cluster: string; readonly service: string }): Promise<EcsServiceScale>;
  /** Set the service's desired count (the scale-up). */
  setDesiredCount(input: {
    readonly cluster: string;
    readonly service: string;
    readonly desiredCount: number;
  }): Promise<void>;
}

/** Build an ECS client from the ambient AWS env (`AWS_ENDPOINT_URL` → the sim). */
export function ecsClientFromEnv(env: Env = process.env): ECSClient {
  const endpoint = env.AWS_ENDPOINT_URL;
  return new ECSClient({
    region: env.AWS_REGION ?? DEFAULT_AWS_REGION,
    maxAttempts: AWS_SDK_MAX_ATTEMPTS,
    retryMode: AWS_SDK_RETRY_MODE,
    ...(endpoint !== undefined && endpoint.length > 0
      ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
}

/** Wrap a real `ECSClient` as an {@link EcsServicePort}. */
export function ecsServiceFromClient(client: ECSClient): EcsServicePort {
  return {
    async describe({ cluster, service }) {
      const out = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
      const svc = out.services?.find(
        (s) => s.serviceName === service || s.serviceArn?.endsWith(`/${service}`) === true,
      );
      if (svc === undefined) {
        throw new Error(`DescribeServices: service '${service}' not found in cluster '${cluster}'`);
      }
      if (svc.desiredCount === undefined || svc.runningCount === undefined) {
        throw new Error(
          `DescribeServices: service '${service}' returned no desiredCount/runningCount`,
        );
      }
      return { desiredCount: svc.desiredCount, runningCount: svc.runningCount };
    },
    async setDesiredCount({ cluster, service, desiredCount }) {
      await client.send(new UpdateServiceCommand({ cluster, service, desiredCount }));
    },
  };
}
