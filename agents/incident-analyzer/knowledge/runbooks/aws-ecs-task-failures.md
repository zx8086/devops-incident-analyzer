---
triggers:
  metrics:
    - ecs
    - task
    - task-failure
    - runningCount
    - desiredCount
    - service-degraded
  services:
    - ecs
  match: any
---
# AWS ECS Task Failures Investigation

## Symptoms
- ECS service reporting `runningCount < desiredCount`
- Tasks stuck in `PROVISIONING`, `PENDING`, or repeatedly transitioning to `STOPPED`
- Service events stream shows repeated `Task failed ELB health checks` or `unable to place a task because no container instance met all of its requirements`
- CloudWatch alarms firing on `aws/ecs/CPUUtilization` or custom service-level error-rate metrics

## Investigation Steps

### 1. List clusters and target the affected one
Use `aws_ecs_list_clusters` if the cluster name is not already in the entity-extracted state. Confirm the cluster ARN before drilling down.

### 2. Describe services to surface task-count drift and recent events
Use `aws_ecs_describe_services` with the cluster ARN and the service name. The response contains:
- `runningCount` vs `desiredCount` (numeric gap)
- `pendingCount` (tasks the scheduler is trying to place)
- `events[]` (the most recent 100 service events, often the most useful field; quote these verbatim in any finding)
- `deployments[]` (in-progress rollouts may explain transient gaps)

If the gap is recent and `deployments[0].status` is `PRIMARY` with `rolloutState: IN_PROGRESS`, the drift may be expected — confirm against the rollout window before raising as an incident.

### 3. List failing task ARNs
Use `aws_ecs_list_tasks` with `desiredStatus: STOPPED` to enumerate recently failed tasks. Cap the result at the 20 most recent unless deeper history is needed.

### 4. Describe stopped tasks to get exit codes and stop reasons
Use `aws_ecs_describe_tasks` with up to 100 task ARNs per call. The critical fields:
- `stoppedReason` (string explaining why the scheduler killed the task)
- `containers[].exitCode` (0 = clean exit, non-zero = application error)
- `containers[].reason` (e.g., `OutOfMemoryError: Container killed due to memory usage`)
- `stopCode` (`TaskFailedToStart`, `EssentialContainerExited`, `UserInitiated`, etc.)

`OutOfMemoryError` or `exitCode: 137` (SIGKILL) is the most common application-side cause. `TaskFailedToStart` usually points to an image-pull or IAM-role problem.

### 5. Locate the service's log group
Use `aws_logs_describe_log_groups` with `logGroupNamePrefix: /aws/ecs/<service-name>` (or `/ecs/<service-name>` for legacy naming). If the service uses the awslogs driver, the log group name is in the task definition's `containerDefinitions[].logConfiguration.options.awslogs-group`.

### 6. Query application logs around the failure window
Use `aws_logs_start_query` against the log group identified in step 5. A focused Insights query:

```
fields @timestamp, @message
| filter @timestamp >= now(-30m)
| filter @message like /ERROR|FATAL|panic|Exception/
| sort @timestamp desc
| limit 50
```

Wait 5–15 seconds, then call `aws_logs_get_query_results` with the queryId. If the query is still `Running`, poll once more after a short delay before giving up.

### 7. Check the security group and VPC posture
If `stoppedReason` mentions networking failure (`unable to assume role`, `network interface not found`, `health check timeout`), use `aws_ec2_describe_security_groups` on the service's security group(s). Look for missing egress rules to dependent services (DynamoDB, RDS, third-party APIs).

### 8. Correlate against the rollout history
If the failures correlate with a recent service revision (deployment), the task definition itself is the likely culprit. Service events will reference `taskDefinition: arn:aws:ecs:...:task-definition/<family>:<rev>`. Compare the failing revision against the previous one for environment-variable changes, image-tag changes, or memory/CPU reductions.

## Cross-Datasource Correlation

The Phase 5 (SIO-761) correlation rule `aws-ecs-degraded-needs-elastic-traces` fires when AWS findings show ECS task failures **and** Elastic traces are not part of the answer. The supervisor re-fans-out to elastic-agent to pull APM traces and application logs from the affected service window.

- AWS ECS task failures + Elastic APM error traces from the same service → application crash; treat as the same incident, not two
- AWS ECS task failures + Kong Konnect 5xx on upstream routes → user-visible outage; surface in the executive summary
- AWS ECS task failures + Couchbase fatal-requests spike → downstream-database dependency; the service is healthy but blocked

## Escalation Criteria
- All tasks for a production service failing (`runningCount: 0`): page on-call
- A single task failing in a multi-task service with autoscaling intact: monitor, do not page
- `OutOfMemoryError` repeating across consecutive deployments: notify owning team to right-size the task definition

## Known Configuration Gaps (don't re-flag as findings)
- If `aws_ecs_describe_tasks` returns `AccessDenied` despite the service being visible to `aws_ecs_describe_services`, link to [`aws-iam-permission-troubleshooting.md`](./aws-iam-permission-troubleshooting.md). `ecs:DescribeTasks` is a separate IAM action from `ecs:DescribeServices`.
- If the service uses Fargate and `aws_ec2_describe_security_groups` returns empty for the SG IDs in the task definition, the SGs may live in a different account (cross-account VPC peering) and require the operator to widen the IAM scope before further drill-down.

## Recovery Actions (Require Human Approval)
- Force-stop the failing service revision and roll back to the previous task definition
- Scale `desiredCount` down to 0, then back up, to clear stuck placements
- Adjust task-definition memory/CPU and create a new revision

## All Tools Used Are Read-Only
aws_ecs_list_clusters, aws_ecs_describe_services, aws_ecs_list_tasks, aws_ecs_describe_tasks, aws_logs_describe_log_groups, aws_logs_start_query, aws_logs_get_query_results, aws_ec2_describe_security_groups, elasticsearch_search
