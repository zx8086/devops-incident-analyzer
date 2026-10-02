---
triggers:
  metrics:
    - probe
    - live
    - check
    - promotion
  severity:
    - high
  match: any
status: draft
---
# Probe Live Check 3 Promotion Pr (DRAFT)

Confirm the target group health check path before replacing ECS tasks

## When to use

When an ALB target group keeps marking freshly started ECS tasks unhealthy while the container logs show the service started normally.

## Procedure

Do: Compare the target group health check path and port with the path the service actually serves, and correct the health check instead of restarting or replacing tasks.
Why: A health check that points at a path the service does not serve fails every new task the same way, so task replacement loops without ever fixing the cause.
Confirm with: aws elbv2 describe-target-groups --names example-service-tg --query 'TargetGroups[0].[HealthCheckPath,HealthCheckPort,Matcher.HttpCode]' and compare the result with a request to the same path from inside the task.

## Evidence

- aws elbv2 describe-target-health --target-group-arn [ARN_REDACTED] -> all targets unhealthy, reason Target.ResponseCodeMismatch, health check path returns 404
- aws ecs describe-services --cluster example-cluster --services example-service -> tasks replaced 14 times in 2 hours, each deregistered after failing the same health check

## Provenance

- source: fleet
- learned_from: fleet:probe/live-check
- approved from the learning review pane (SIO-1891); review before relying on it
