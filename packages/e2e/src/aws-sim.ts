// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateRouteCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DescribeRouteTablesCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";

interface AwsSimCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AwsSimClientConfig {
  region: string;
  endpoint: string;
  credentials: AwsSimCredentials;
}

const DEFAULT_CREDENTIALS: AwsSimCredentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
};

export function configureAwsSimEnv(): void {
  process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
  process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
  process.env.AWS_ACCESS_KEY_ID ??= DEFAULT_CREDENTIALS.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY ??= DEFAULT_CREDENTIALS.secretAccessKey;
}

export function awsSimClientConfig(
  credentials: AwsSimCredentials = DEFAULT_CREDENTIALS,
): AwsSimClientConfig {
  return {
    region: DEFAULT_AWS_REGION,
    endpoint: aws.endpoint,
    credentials,
  };
}

export function required<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${field}`);
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface SimVpc {
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
}

/**
 * VPC + subnet + security group with normal AWS egress state: an attached IGW
 * and a 0.0.0.0/0 route in the main route table. Container-mode netns tasks
 * need this (plus AssignPublicIp=ENABLED) to reach simulator-adjacent
 * endpoints — the sim models real route-table egress (sockerless #520).
 */
export async function createVpcWithEgress(
  ec2: EC2Client,
  opts: { vpcCidr: string; subnetCidr: string; securityGroupName: string },
): Promise<SimVpc> {
  const vpcOut = await ec2.send(new CreateVpcCommand({ CidrBlock: opts.vpcCidr }));
  const vpcId = required(vpcOut.Vpc?.VpcId, "VpcId");
  const subnetOut = await ec2.send(
    new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: opts.subnetCidr }),
  );
  const subnetId = required(subnetOut.Subnet?.SubnetId, "SubnetId");
  const sgOut = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: opts.securityGroupName,
      Description: `${opts.securityGroupName} (e2e)`,
      VpcId: vpcId,
    }),
  );
  const securityGroupId = required(sgOut.GroupId, "GroupId");

  const igwOut = await ec2.send(new CreateInternetGatewayCommand({}));
  const internetGatewayId = required(
    igwOut.InternetGateway?.InternetGatewayId,
    "InternetGatewayId",
  );
  await ec2.send(
    new AttachInternetGatewayCommand({ InternetGatewayId: internetGatewayId, VpcId: vpcId }),
  );
  const routeTables = await ec2.send(
    new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }),
  );
  const routeTableId = required(
    routeTables.RouteTables?.find((rt) => rt.Associations?.some((association) => association.Main))
      ?.RouteTableId,
    "RouteTableId",
  );
  await ec2.send(
    new CreateRouteCommand({
      RouteTableId: routeTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: internetGatewayId,
    }),
  );
  return { vpcId, subnetId, securityGroupId };
}
