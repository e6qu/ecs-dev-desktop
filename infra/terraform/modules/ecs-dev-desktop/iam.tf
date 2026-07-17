# SPDX-License-Identifier: AGPL-3.0-or-later
# IAM: a shared task-execution role; least-privilege task roles for the control
# plane and the reconciler; the ECS infrastructure role for managed-EBS volumes;
# and the EventBridge Scheduler role that launches the reconciler.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---- Task execution role (image pull, log write, secret injection) ----

resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_extra" {
  statement {
    sid       = "DecryptForInjection"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
  }
  dynamic "statement" {
    for_each = length(var.secret_environment) > 0 ? [1] : []
    content {
      sid       = "ReadInjectedSecrets"
      actions   = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
      resources = values(var.secret_environment)
    }
  }

  # The same execution role backs the per-workspace task definitions (the control
  # plane passes it as their executionRoleArn), so it must read the runtime-created
  # agent secret to inject EDD_AGENT_TOKEN into the workspace container at launch.
  statement {
    sid       = "ReadWorkspaceAgentSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.workspace_agent_secret_arns]
  }
}

resource "aws_iam_role_policy" "execution_extra" {
  name   = "${var.name}-execution-extra"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_extra.json
}

# ---- ECS infrastructure role for managed EBS volumes ----
# ECS assumes this to create/attach/delete the workspace's managed EBS volume on
# RunTask; the control plane passes it (see control-plane PassRole below).

data "aws_iam_policy_document" "ecs_infra_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_infrastructure" {
  name               = "${var.name}-ecs-infrastructure"
  assume_role_policy = data.aws_iam_policy_document.ecs_infra_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_infrastructure" {
  role       = aws_iam_role.ecs_infrastructure.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForVolumes"
}

# ---- Control-plane task role (the app's runtime AWS permissions) ----

data "aws_iam_policy_document" "control_plane" {
  statement {
    sid       = "DynamoSingleTable"
    actions   = ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  }

  # The single table is encrypted with our customer-managed KMS key; unlike the
  # execution role's DecryptForInjection (Secrets Manager, at container launch), the
  # RUNNING APP's own DynamoDB calls go through this task role, which needs its own
  # direct KMS grant (DynamoDB does not proxy CMK access via a service-only grant the
  # way CloudWatch Logs does) — found live: /workspaces failed with
  # `kms:Decrypt ... AccessDeniedException` on the first real DynamoDB read.
  statement {
    sid       = "DecryptSingleTable"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.this.arn]
  }

  statement {
    sid       = "RunAndManageWorkspaceTasks"
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }

  # RegisterTaskDefinition/DescribeTaskDefinition are NOT cluster-scoped (task
  # definitions are account/region-level resources, registered independent of any
  # cluster). Grouping them under the `ecs:cluster` condition above (as a prior
  # version of this file did) meant that key was never populated in their request
  # context, so the condition could never be satisfied — every real
  # RegisterTaskDefinition call was silently denied. Found live: the first real
  # workspace launch failed with "not authorized to perform:
  # ecs:RegisterTaskDefinition ... no identity-based policy allows the
  # ecs:RegisterTaskDefinition action". Per AWS's IAM condition-key reference:
  # RegisterTaskDefinition supports the `task-definition` resource type (scoped to
  # the workspace family prefix, WORKSPACE_TASKDEF_FAMILY_PREFIX in
  # @edd/compute-ecs); DescribeTaskDefinition supports no resource types or
  # condition keys at all (wildcard-only), so it gets its own unscoped statement.
  #
  # ecs:TagResource is granted HERE (on the task-definition resource), not only on
  # RunAndManageWorkspaceTasks: `RegisterTaskDefinition` now sends cost-scope `tags`,
  # and AWS authorizes those inline tags against `ecs:TagResource` on the
  # task-definition being registered. The cluster-scoped TagResource above cannot
  # satisfy it because `ecs:cluster` is absent from the registration request context —
  # exactly the same false-drift class as the RegisterTaskDefinition bug above. Found
  # live after tagging landed: workspace launch failed with "not authorized to perform:
  # ecs:TagResource on resource: .../edd-ws-*:* because no identity-based policy allows
  # the ecs:TagResource action".
  statement {
    sid       = "RegisterWorkspaceTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:TagResource"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:task-definition/edd-ws-*:*"]
  }

  statement {
    sid       = "DescribeTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "ManagedEbsLifecycle"
    actions   = ["ec2:CreateVolume", "ec2:CreateSnapshot", "ec2:CreateTags", "ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeTags"]
    resources = ["*"]
  }

  statement {
    sid       = "ReapManagedEbsOnly"
    actions   = ["ec2:DeleteVolume", "ec2:DeleteSnapshot", "ec2:DetachVolume"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/edd:managed"
      values   = ["true"]
    }
  }

  # ---- Admin Images console (image metadata + build triggering/monitoring) ----
  # Constructed ARNs (not resource refs) so these hold regardless of image_build_mode
  # (the CodeBuild project + its log group are count-gated for codebuild mode only).
  statement {
    sid       = "ImageConsoleEcrRead"
    actions   = ["ecr:DescribeImages", "ecr:ListImages", "ecr:BatchGetImage"]
    resources = ["arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/${var.name}/*"]
  }
  statement {
    sid       = "ImageConsoleCodeBuild"
    actions   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:ListBuildsForProject"]
    resources = ["arn:${local.partition}:codebuild:${local.region}:${local.account_id}:project/${var.name}-build-images"]
  }
  statement {
    sid       = "ImageConsoleBuildLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${var.name}-build-images:*"]
  }
  statement {
    sid       = "AwsPriceListRead"
    actions   = ["pricing:GetProducts"]
    resources = ["*"]
  }
  statement {
    sid       = "AwsCostExplorerRead"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }
  statement {
    sid       = "SendInvitationEmail"
    actions   = ["ses:SendEmail"]
    resources = ["*"]
  }

  # ---- Admin-managed CloudFront WAF (waf-cloudfront.tf) ----
  # The control plane owns the live edge rule set + admin CIDR IP set after terraform
  # seeds them (terraform then ignores those changes). Get/Update are scoped to the two
  # CLOUDFRONT-scope ARNs the module creates; List/DescribeManagedRuleGroup have no
  # resource-level scoping (account-wide by API design). Gated so an HTTP-only or
  # WAF-disabled stack grants nothing here.
  dynamic "statement" {
    for_each = local.cloudfront_waf_enabled ? [1] : []
    content {
      sid       = "ManageCloudFrontWaf"
      actions   = ["wafv2:GetWebACL", "wafv2:UpdateWebACL", "wafv2:GetIPSet", "wafv2:UpdateIPSet"]
      resources = [aws_wafv2_web_acl.cloudfront[0].arn, aws_wafv2_ip_set.cloudfront_admin[0].arn]
    }
  }
  dynamic "statement" {
    for_each = local.cloudfront_waf_enabled ? [1] : []
    content {
      sid       = "IntrospectCloudFrontWaf"
      actions   = ["wafv2:ListIPSets", "wafv2:ListWebACLs", "wafv2:GetManagedRuleSet", "wafv2:DescribeManagedRuleGroup"]
      resources = ["*"]
    }
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.ecs_infrastructure.arn, aws_iam_role.workspace.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com", "ecs.amazonaws.com"]
    }
  }

  # The control plane creates a per-workspace agent-token secret at launch
  # (CreateSecret/PutSecretValue), tags it for GC, and deletes it on terminate —
  # scoped to the edd/workspace/* name prefix, never all secrets.
  statement {
    sid = "ManageWorkspaceAgentSecrets"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteSecret",
    ]
    resources = [local.workspace_agent_secret_arns]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = ["${aws_cloudwatch_log_group.workspaces.arn}:*", "${aws_cloudwatch_log_group.control_plane.arn}:*", "${aws_cloudwatch_log_group.reconciler.arn}:*"]
  }

  # DescribeLogGroups supports no resource types or condition keys at all (it lists
  # every log group in the account) -- grouping it under the log-group-scoped Logs
  # statement above meant it was silently denied. Found live via the admin
  # infrastructure config-sync check: "iam-permissions:control-plane(drift) -- ...
  # logs:DescribeLogGroups" denied.
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid       = "CloudTrailLookup"
    actions   = ["cloudtrail:LookupEvents"]
    resources = ["*"]
  }

  # Per-workspace monitoring reads (Container Insights task utilization, EBS
  # volume IOPS). CloudWatch metrics support no resource-level scoping --
  # GetMetricData is account-wide by design.
  statement {
    sid       = "CloudWatchMetricsRead"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }

  # Read-only cluster/AZ introspection for the admin health board (compute + storage
  # provider health checks). DescribeClusters supports the `cluster` resource type;
  # DescribeAvailabilityZones is account/region-wide (no resource type at all, per
  # AWS's EC2 IAM reference -- the API call itself takes no resource identifier).
  # Found live: /admin/health reported both "compute" and "storage" DOWN with
  # AccessDeniedException -- neither action had ever been granted.
  statement {
    sid       = "DescribeWorkspacesCluster"
    actions   = ["ecs:DescribeClusters"]
    resources = [local.ecs_cluster_arn]
  }

  statement {
    sid       = "DescribeAvailabilityZones"
    actions   = ["ec2:DescribeAvailabilityZones"]
    resources = ["*"]
  }

  # Read-only IAM self-check: the control plane asks whether its own identity is
  # actually allowed each action its components need (the IAM_REQUIREMENTS manifest),
  # surfaced in the config-sync report. Introspection only — neither action can
  # modify anything, and both are inherently account-scoped ("*").
  statement {
    sid       = "IamSelfCheck"
    actions   = ["iam:SimulatePrincipalPolicy", "sts:GetCallerIdentity"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.secret_environment) > 0 ? [1] : []
    content {
      sid       = "ReadSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = values(var.secret_environment)
    }
  }
}

resource "aws_iam_role" "control_plane" {
  name               = "${var.name}-control-plane"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "control_plane" {
  name   = "${var.name}-control-plane"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane.json
}

# ---- Workspace task role (the per-workspace container's runtime identity) ----
# The control plane passes this as each workspace task definition's task_role_arn.
# The workspace container reaches the control plane over HMAC-authenticated HTTP
# (idle-agent heartbeats, the git-credential broker) and makes no direct AWS calls,
# so the role carries NO permissions by design — least privilege. It still exists so
# tasks run under a distinct, auditable identity (CloudTrail attribution) and so the
# executionRoleArn (ECR pull / log / secret injection) stays separate from runtime.
resource "aws_iam_role" "workspace" {
  name               = "${var.name}-workspace"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

# ---- Reconciler task role (idle stop, scheduled snapshots, orphan GC) ----

data "aws_iam_policy_document" "reconciler" {
  # DeleteItem: finishDeleting removes the workspace record -- found live: EVERY
  # deletion stalled in `deleting` forever ("finishDeleting threw ... not
  # authorized to perform: dynamodb:DeleteItem"). BatchWriteItem: the post-sweep
  # cost-rollup checkpoint (replaceAll) batch-writes -- same sweep logged the
  # matching AccessDenied.
  statement {
    sid       = "DynamoSingleTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  }
  statement {
    sid       = "DecryptSingleTable"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.this.arn]
  }
  statement {
    sid       = "StopIdleTasks"
    actions   = ["ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }
  # Scale-to-zero for the control plane itself: the idle-shutdown sweep flips the
  # control-plane ECS service's desired count to 0 (and back up) once the last human
  # session goes idle. Scoped to the control-plane service ARN — the reconciler can
  # scale ONLY that service, not arbitrary services. UpdateService with the service's
  # own name in the request context populates ecs:cluster, so the condition holds.
  statement {
    sid       = "ScaleControlPlaneService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [local.control_plane_service_arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }
  statement {
    sid       = "SnapshotAndGc"
    actions   = ["ec2:CreateSnapshot", "ec2:CreateTags", "ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeTags"]
    resources = ["*"]
  }
  statement {
    sid       = "ReapManagedEbsOnly"
    actions   = ["ec2:DeleteVolume", "ec2:DeleteSnapshot"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/edd:managed"
      values   = ["true"]
    }
  }
  # Orphan-secret GC: list the agent secrets (account-scoped; tag-filtered in code)
  # and delete those whose workspace record is gone — scoped to the edd/workspace/*
  # name prefix.
  statement {
    sid       = "ListSecretsForReaping"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }
  statement {
    sid       = "ReapWorkspaceAgentSecrets"
    actions   = ["secretsmanager:DeleteSecret"]
    resources = [local.workspace_agent_secret_arns]
  }
  # Task-definition GC: deregister stale workspace revisions (List/Deregister are
  # account-scoped; the reconciler filters to the edd-ws-* families in code).
  statement {
    sid       = "PruneWorkspaceTaskDefinitions"
    actions   = ["ecs:ListTaskDefinitionFamilies", "ecs:ListTaskDefinitions", "ecs:DeregisterTaskDefinition"]
    resources = ["*"]
  }
  # Read-only IAM self-check (same as the control-plane's IamSelfCheck): the
  # reconciler asks whether its own identity holds each action it needs and logs
  # the result at sweep start. Without this it degrades to "unknown" — found
  # live: every real sweep logged `iam:SimulatePrincipalPolicy not permitted
  # (AccessDenied)`. Introspection only; both actions are account-scoped ("*").
  statement {
    sid       = "IamSelfCheck"
    actions   = ["iam:SimulatePrincipalPolicy", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "reconciler" {
  name               = "${var.name}-reconciler"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "reconciler" {
  name   = "${var.name}-reconciler"
  role   = aws_iam_role.reconciler.id
  policy = data.aws_iam_policy_document.reconciler.json
}

# ---- EventBridge Scheduler role (launches the reconciler task) ----

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "RunReconciler"
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.reconciler.arn_without_revision}:*", aws_ecs_task_definition.reconciler.arn]
    condition {
      test     = "ArnLike"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }
  # The schedule target propagates tags (enable_ecs_managed_tags + propagate_tags + tags, reconciler.tf),
  # so the scheduler's RunTask ALSO tags the created TASK — which AWS authorizes against ecs:TagResource
  # on the task resource, SEPARATELY from ecs:RunTask on the task-def. Without this, every invocation
  # fails "not authorized to perform: ecs:TagResource on resource: .../task/<cluster>/*" and the
  # reconciler never launches — silently, since failures land in the DLQ (this is exactly what took the
  # reconciler down for ~14h: no scale-to-zero, no snapshots, no orphan-task reaping). Scoped to this
  # cluster, mirroring the control-plane role's RunAndManageWorkspaceTasks grant.
  statement {
    sid       = "TagReconcilerTask"
    actions   = ["ecs:TagResource"]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }
  statement {
    sid       = "PassReconcilerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.reconciler.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  # Deliver a failed sweep invocation to the dead-letter queue.
  statement {
    sid       = "ReconcilerDeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.reconciler_dlq.arn]
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.name}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}
