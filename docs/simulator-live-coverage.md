<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Live Simulator Coverage

This page tracks what parts of ecs-dev-desktop are already tested against live
sockerless simulators, and what app surfaces can move there next. Product code
must remain endpoint-only: simulator and AWS behavior differ only by endpoint,
credentials, and normal cloud configuration.

## Current Coverage

| Surface                          | Simulator                       | Tests / jobs                                                      | What it proves                                                                                                                             |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace lifecycle service      | AWS sim + DynamoDB Local        | `packages/e2e/src/workspace-lifecycle.e2e.ts`                     | API-facing control-plane lifecycle wiring with real adapters where the cloud surface is involved.                                          |
| Stateful workspace data path     | AWS container mode              | `packages/e2e/src/workspace-data-fidelity.e2e.ts`                 | Fargate-style task execution, managed EBS attach/snapshot/restore, and data fidelity observed through a task container.                    |
| ECS awsvpc networking            | AWS container mode              | `packages/e2e/src/ecs-overlapping-vpc.e2e.ts`                     | Real ENI addresses, overlapping-CIDR VPC isolation, same-VPC reachability, and VPC cleanup through standard AWS APIs.                      |
| Reconciler container             | AWS container mode              | `packages/e2e/src/reconciler-container.e2e.ts`                    | EventBridge schedule fires, ECS `RunTask` launches the reconciler image, route-table egress works, and CloudWatch Logs capture the result. |
| Terraform module                 | AWS process mode                | `terraform-sim` CI job                                            | Full module apply/assert/idempotency/destroy for default, fck-nat, and DNS/TLS configurations.                                             |
| CloudTrail / CloudWatch adapters | AWS process mode                | `@edd/cloudtrail-audit`, `@edd/cloudwatch-logs` integration tests | Admin observability ports use real SDK calls and sim-backed CloudTrail/CloudWatch data.                                                    |
| GitHub auth role mapping         | `bleephub`                      | `apps/web/lib/github-auth.e2e.ts`                                 | OAuth code flow, token exchange, team lookup, and group-to-role mapping without a mock IdP.                                                |
| Entra auth role mapping          | Azure/Entra sim                 | `apps/web/lib/entra-auth.e2e.ts`, `e2e-https`                     | Graph user/group provisioning, token flow, JWKS validation, and group-to-role mapping over HTTP and TLS.                                   |
| Pomerium workspace routing       | Azure/Entra sim + real Pomerium | `packages/e2e/src/proxy-routing.e2e.ts`, `pomerium-authed.e2e.ts` | Wildcard workspace routing, identity gate, full OIDC callback, session cookie, and identity header injection.                              |
| SSH certificate access           | OpenSSH container               | `services/ssh-gateway/src/ssh-connect.e2e.ts`                     | Standard `sshd` with trusted CA and `AuthorizedPrincipalsFile` RBAC.                                                                       |

## Next Live-Test Candidates

These are feasible against the current simulators and should stay in this PR's
testing model: no product branches, no special fake code paths.

| Candidate                                               | Simulator path                                                                                                                      | Reason                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin API routes with real observability adapters       | Next route tests or Playwright with `AUDIT_PROVIDER=cloudtrail`, `LOG_PROVIDER=cloudwatch`, `AWS_ENDPOINT_URL` set to the AWS sim   | Today the adapters are sim-tested at package level and the UI is Playwright-tested with local adapters. This would prove the app route wiring against live CloudTrail/CloudWatch. |
| Portal/admin browser lifecycle against real ECS compute | Playwright against built `apps/web` with `COMPUTE_PROVIDER=ecs`, `STORAGE_PROVIDER=ec2`, DynamoDB Local, and AWS container-mode sim | Moves create/stop/snapshot UI flows from local/fake compute to the same live container-mode path used by package e2e.                                                             |
| Browser OIDC login through Pomerium                     | Playwright against Pomerium + Azure/Entra sim                                                                                       | The HTTP-client e2e already proves the flow. Browser coverage would prove cookie and redirect behavior in the user agent.                                                         |
| Full user journey without fake compute                  | Replace the current fake compute/storage parts of `packages/e2e/src/user-journey.e2e.ts` with AWS container-mode adapters           | Would combine portal, API, ECS task launch, stateful storage, and SSH/proxy readiness once the wake-on-connect proxy branch lands.                                                |
| Next/Auth.js callback routes against sim IdPs           | App route tests using `bleephub` and Azure/Entra sim endpoints                                                                      | Current auth e2e exercises the same helper code and IdP protocol surfaces; this would also prove Auth.js route callback wiring.                                                   |

Container-mode ECS tasks that reach simulator-adjacent services must be configured
like normal AWS tasks: route-table egress exists and public egress is explicit
(`AssignPublicIp=ENABLED` or a NAT path). That is test harness cloud state, not a
simulator-specific product branch.

## Still Real-AWS Only

- Real EBS durability/latency and lazy snapshot hydrate behavior.
- Real Fargate placement, ENI behavior at scale, cold-start, and 200+ workspace load.
- Live GitHub organization and Azure Entra federation with production tenant policies.
- ACM issuance, public DNS propagation, and real wildcard workspace domains.
- IAM least-privilege enforcement, KMS grants, cross-region snapshot copy, and DR.
- Cost Explorer/CUR and production-grade CloudWatch Metrics.
