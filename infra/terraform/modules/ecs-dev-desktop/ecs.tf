# SPDX-License-Identifier: AGPL-3.0-or-later
# ECS Fargate: the cluster, the control-plane (Next.js) service behind the ALB,
# and the reconciler task definition (launched on a schedule, see reconciler.tf).
# Per-user workspace tasks are registered/run *at runtime* by the control plane,
# not declared here — this module gives them the cluster, networking, IAM, and
# managed-EBS infrastructure role they need.

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-workspaces"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.this.arn
      logging    = "DEFAULT"
    }
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

locals {
  base_environment = {
    NODE_ENV        = "production"
    PORT            = tostring(var.control_plane_port)
    AWS_REGION      = local.region
    DYNAMODB_TABLE  = var.dynamodb_table_name
    ECS_CLUSTER     = aws_ecs_cluster.this.name
    EDD_KMS_KEY_ARN = aws_kms_key.this.arn
    # Real adapter selection: tells apps/web to use EcsComputeProvider + Ec2StorageProvider.
    COMPUTE_PROVIDER    = "ecs"
    CONTROL_PLANE_URL   = local.dns_enabled ? "https://${local.control_plane_fqdn}" : "http://${aws_lb.this.dns_name}"
    ECS_SUBNETS         = join(",", aws_subnet.private[*].id)
    ECS_SECURITY_GROUPS = aws_security_group.tasks.id
    ECS_EBS_ROLE_ARN    = aws_iam_role.ecs_infrastructure.arn
    # Phase 8C: CloudTrail audit + CloudWatch Logs adapters (endpoint-only swap).
    AUDIT_PROVIDER = "cloudtrail"
    LOG_PROVIDER   = "cloudwatch"
    EDD_APP_NAME   = var.name
    # CloudWatch log group for workspace container stdout/stderr (awslogs driver).
    ECS_LOG_GROUP_WORKSPACES = aws_cloudwatch_log_group.workspaces.name
  }
  ssh_environment = var.ssh_ca_public_key == "" ? {} : {
    EDD_SSH_CA_PUBLIC_KEY = var.ssh_ca_public_key
  }
  control_plane_environment = merge(local.base_environment, local.ssh_environment, var.extra_environment)
}

resource "aws_ecs_task_definition" "control_plane" {
  family                   = "${var.name}-control-plane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.control_plane_cpu)
  memory                   = tostring(var.control_plane_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  container_definitions = jsonencode([{
    name      = "control-plane"
    image     = local.control_plane_image
    essential = true
    portMappings = [{
      containerPort = var.control_plane_port
      protocol      = "tcp"
    }]
    environment = [for k, v in local.control_plane_environment : { name = k, value = v }]
    secrets     = [for k, arn in var.secret_environment : { name = k, valueFrom = arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.control_plane.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "app"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.control_plane_port}/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])

  # Fail loudly on a half-configured SSH CA. ssh_ca_public_key makes workspace
  # tasks trust the CA (EDD_SSH_CA_PUBLIC_KEY), but certificates are signed by the
  # control plane with the CA *private* key (EDD_SSH_CA_KEY, from secret_environment).
  # With the public key set and no private key, SSH is advertised yet unusable, and it
  # would only surface at runtime when the ssh-cert route throws — so catch it at plan
  # time. (The reverse, key material with no public key, just leaves SSH disabled on
  # workspaces, which is benign.) See docs/deploying.md Step 4.
  lifecycle {
    precondition {
      condition     = var.ssh_ca_public_key == "" || contains(keys(var.secret_environment), "EDD_SSH_CA_KEY")
      error_message = "ssh_ca_public_key is set but secret_environment has no EDD_SSH_CA_KEY: workspace sshd would trust the CA while the control plane has no private key to sign certificates. Add EDD_SSH_CA_KEY (the CA private-key Secrets Manager ARN) to secret_environment, or unset ssh_ca_public_key. See docs/deploying.md Step 4."
    }
  }

  tags = local.tags
}

resource "aws_ecs_service" "control_plane" {
  name            = "${var.name}-control-plane"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = var.control_plane_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control_plane.arn
    container_name   = "control-plane"
    container_port   = var.control_plane_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Desired count is owned by autoscaling once it attaches.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.tags
}

# ---- Autoscaling for the control plane ----

resource "aws_appautoscaling_target" "control_plane" {
  max_capacity       = var.control_plane_max_count
  min_capacity       = var.control_plane_min_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.control_plane.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "control_plane_cpu" {
  name               = "${var.name}-control-plane-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.control_plane.resource_id
  scalable_dimension = aws_appautoscaling_target.control_plane.scalable_dimension
  service_namespace  = aws_appautoscaling_target.control_plane.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# ---- Reconciler task definition ----

resource "aws_ecs_task_definition" "reconciler" {
  family                   = "${var.name}-reconciler"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.reconciler.arn

  container_definitions = jsonencode([{
    name        = "reconciler"
    image       = local.control_plane_image
    essential   = true
    command     = var.reconciler_command
    environment = [for k, v in local.base_environment : { name = k, value = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.reconciler.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "reconciler"
      }
    }
  }])

  tags = local.tags
}
