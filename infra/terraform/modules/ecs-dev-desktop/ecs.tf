# SPDX-License-Identifier: AGPL-3.0-or-later
# ECS Fargate: the cluster, the control-plane (Next.js) service behind the ALB,
# and the reconciler task definition (launched on a schedule, see reconciler.tf).
# Per-user workspace tasks are registered/run *at runtime* by the control plane,
# not declared here — this module gives them the cluster, networking, IAM, and
# managed-EBS infrastructure role they need.

resource "aws_ecs_cluster" "this" {
  count = local.managed_cluster ? 1 : 0
  name  = "${var.name}-workspaces"

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
  count              = local.managed_cluster ? 1 : 0
  cluster_name       = aws_ecs_cluster.this[0].name
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
    ECS_CLUSTER     = local.ecs_cluster_name
    EDD_KMS_KEY_ARN = aws_kms_key.this.arn
    # Real adapter selection: tells apps/web to use EcsComputeProvider + Ec2StorageProvider.
    COMPUTE_PROVIDER  = "ecs"
    CONTROL_PLANE_URL = local.dns_enabled ? "https://${local.control_plane_fqdn}" : "http://${aws_lb.this.dns_name}"
    ECS_SUBNETS       = join(",", local.private_subnet_ids)
    # Workspace tasks the control plane launches get the dedicated workspaces SG
    # (editor/sshd reachable only from the control plane), NOT the control-plane SG.
    ECS_SECURITY_GROUPS = aws_security_group.workspaces.id
    ECS_EBS_ROLE_ARN    = aws_iam_role.ecs_infrastructure.arn
    # Roles for the per-workspace task definitions the control plane registers:
    # execution (ECR pull, awslogs, agent-secret injection) + the workspace runtime
    # task role. Without these the registered workspace task defs have no roles.
    ECS_EXECUTION_ROLE_ARN = aws_iam_role.execution.arn
    ECS_TASK_ROLE_ARN      = aws_iam_role.workspace.arn
    # Phase 8C: CloudTrail audit + CloudWatch Logs adapters (endpoint-only swap).
    AUDIT_PROVIDER = "cloudtrail"
    LOG_PROVIDER   = "cloudwatch"
    EDD_APP_NAME   = var.name
    # Cost-allocation tag value injected into runtime-created resources
    # (workspace tasks, managed EBS volumes, snapshots, runtime secrets).
    EDD_COST_SCOPE = var.cost_scope
    # Golden variants this deployment builds — the Images console lists their ECR repos.
    EDD_GOLDEN = join(" ", var.golden_image_repos)
    # CloudWatch log group for workspace container stdout/stderr (awslogs driver).
    ECS_LOG_GROUP_WORKSPACES = aws_cloudwatch_log_group.workspaces.name
    # Scale-to-zero tuning (read by the reconciler and injected into workspace tasks).
    EDD_IDLE_THRESHOLD_MS          = tostring(var.idle_threshold_ms)
    EDD_SNAPSHOT_INTERVAL_MS       = tostring(var.snapshot_interval_ms)
    EDD_EARLY_SNAPSHOT_INTERVAL_MS = tostring(var.early_snapshot_interval_ms)
    EDD_EARLY_SESSION_MS           = tostring(var.early_session_ms)
    EDD_GC_GRACE_MS                = tostring(var.gc_grace_ms)
    EDD_UNDELETE_RETENTION_MS      = tostring(var.undelete_retention_ms)
    EDD_PROVISIONING_TIMEOUT_MS    = tostring(var.provisioning_timeout_ms)
    EDD_HEARTBEAT_INTERVAL_S       = tostring(var.heartbeat_interval_s)
  }
  control_plane_environment = merge(local.base_environment, var.extra_environment)
}

resource "aws_ecs_task_definition" "control_plane" {
  family                   = "${var.name}-control-plane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.control_plane_cpu)
  memory                   = tostring(var.control_plane_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  # Fargate CPU architecture (default ARM64/Graviton — cheaper + faster cold-start). The pushed
  # control-plane image must be multiarch so Fargate pulls the matching per-arch variant.
  runtime_platform {
    cpu_architecture        = var.workspace_cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "control-plane"
    image     = local.effective_control_plane_image
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
      interval    = 10
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])

  tags = local.tags

  # In build modes the images are produced during apply; wait before creating
  # the task definition so the first service deployment can actually pull them.
  depends_on = [
    terraform_data.build_images_local,
    terraform_data.build_images_codebuild,
  ]
}

resource "aws_ecs_service" "control_plane" {
  name            = "${var.name}-control-plane"
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = var.control_plane_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control_plane.arn
    container_name   = "control-plane"
    container_port   = var.control_plane_port
  }

  # Zero-downtime rolling deploys: never drop below desired capacity (100%) while
  # allowing up to double (200%) so new tasks come up and pass health checks
  # alongside the old ones before they're drained -- explicit rather than relying
  # on AWS's (currently identical) defaults, since the app is stateless and this
  # is a real requirement, not an incidental default.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    # Desired count is owned by the scale-to-zero controllers once they attach.
    # Terraform owns the task-definition attachment and rolls it whenever the
    # declared image, environment, resources, or role coordinates change.
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.tags

  # Propagate the service tags (incl. edd:cost-scope) to the RUNNING TASKS. On Fargate,
  # only task-level tags land on the billing usage record — service/task-def tags do not.
  # Without this the always-on control-plane compute (a top steady cost) is invisible to
  # a cost-allocation-tag-scoped Cost Explorer query. Requires ecs:TagResource (granted).
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
}

# ---- Autoscaling scalable target for the control plane ----
# The reconciler (idle shutdown) and the wake Lambda (scale-from-zero) are the SOLE
# authority over the control-plane service's desiredCount now: they drive it between 0
# and control_plane_active_desired for scale-to-zero. We register the service as a
# scalable target (min=0, max) but deliberately attach NO scaling policy:
#   - A CPU target-tracking policy can neither scale FROM 0 (no running task = no CPU
#     metric to react to) nor TO 0 (target tracking's floor is the target's min, and it
#     never sets desiredCount to 0), so it cannot participate in scale-to-zero at all.
#   - Worse, it would FIGHT the reconciler/wake: two controllers writing the same
#     desiredCount race each other (target tracking scaling a woken service back down,
#     or clamping a just-woken service). One capacity authority, not two.
# The scalable target itself is harmless and left registered (min/max are the guard
# rails the reconciler/wake honor, and downstream code/asserts reference it).
resource "aws_appautoscaling_target" "control_plane" {
  max_capacity       = var.control_plane_max_count
  min_capacity       = var.control_plane_min_count
  resource_id        = "service/${local.ecs_cluster_name}/${aws_ecs_service.control_plane.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# ---- Reconciler task definition ----

resource "aws_ecs_task_definition" "reconciler" {
  family                   = "${var.name}-reconciler"
  requires_compatibilities = ["FARGATE"]
  # Keep the old revision ACTIVE when a new one replaces it: the EventBridge
  # schedule targets a SPECIFIC revision, and terraform updates the schedule
  # only after replacing the task definition -- without skip_destroy, every
  # apply had a window where the schedule launched a just-deregistered revision
  # and the run silently landed in the DLQ instead of sweeping (found live: 21
  # accumulated DLQ messages, each a missed reconciler run). Old revisions are
  # inert (nothing launches them once the schedule repoints).
  skip_destroy       = true
  network_mode       = "awsvpc"
  cpu                = tostring(var.reconciler_cpu)
  memory             = tostring(var.reconciler_memory)
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.reconciler.arn

  # Fargate CPU architecture (default ARM64/Graviton). Uses the same multiarch control-plane image.
  runtime_platform {
    cpu_architecture        = var.workspace_cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name        = "reconciler"
    image       = local.effective_control_plane_image
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

  depends_on = [
    terraform_data.build_images_local,
    terraform_data.build_images_codebuild,
  ]
}
