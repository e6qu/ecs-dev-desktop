mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
    }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

run "shared_environment_does_not_duplicate_network_or_cluster" {
  command = plan

  variables {
    name                        = "edd-dev"
    availability_zones          = ["eu-west-1a", "eu-west-1b"]
    use_existing_vpc            = true
    existing_vpc_id             = "vpc-0123456789abcdef0"
    existing_public_subnet_ids  = ["subnet-00000000000000001", "subnet-00000000000000002"]
    existing_private_subnet_ids = ["subnet-00000000000000003", "subnet-00000000000000004"]
    use_existing_ecs_cluster    = true
    existing_ecs_cluster_arn    = "arn:aws:ecs:eu-west-1:123456789012:cluster/dev"
    existing_ecs_cluster_name   = "dev"
    image_tag                   = "0123456789ab"
    control_plane_image         = "example.invalid/ecs-dev-desktop:arm64"
    deletion_protection         = false
    enable_cloudfront           = false
    enable_metric_alarms        = false
    enable_cloudwatch_dashboard = false
    seed_default_catalog        = false
  }

  assert {
    condition     = length(aws_vpc.this) == 0
    error_message = "shared-environment mode created a duplicate VPC"
  }

  assert {
    condition     = length(aws_subnet.public) == 0 && length(aws_subnet.private) == 0
    error_message = "shared-environment mode created duplicate subnets"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 0 && length(module.fck_nat) == 0
    error_message = "shared-environment mode created duplicate NAT infrastructure"
  }

  assert {
    condition     = length(aws_vpc_endpoint.s3) == 0 && length(aws_vpc_endpoint.dynamodb) == 0
    error_message = "shared-environment mode created duplicate gateway endpoints"
  }

  assert {
    condition     = length(aws_ecs_cluster.this) == 0
    error_message = "shared-environment mode created a duplicate Amazon ECS cluster"
  }

  assert {
    condition     = aws_ecs_service.control_plane.cluster == "arn:aws:ecs:eu-west-1:123456789012:cluster/dev"
    error_message = "control plane did not target the shared Amazon ECS cluster"
  }

  assert {
    condition     = toset(aws_ecs_service.control_plane.network_configuration[0].subnets) == toset(["subnet-00000000000000003", "subnet-00000000000000004"])
    error_message = "control plane did not target the shared private subnets"
  }
}
