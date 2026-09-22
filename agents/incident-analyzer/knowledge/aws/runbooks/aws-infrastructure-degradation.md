---
type: Runbook
title: "AWS Infrastructure Degradation and Node Rotation"
description: "Triage ECS, EKS and node-level faults including crashlooping replicas after node rotation, readiness probe failures and IAM authorization errors."
status: stable
tags: [aws, ecs, eks, karpenter, node-rotation, readiness, iam]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - crashloop
    - crashlooping
    - node rotation
    - NodeRepair
    - karpenter
    - readiness probe
    - probe failure
    - task replacement
    - S3 IAM authorization
    - access denied
    - controller election
  match: any
tools:
  - aws_ecs_describe_services
  - aws_ecs_describe_tasks
  - aws_ecs_describe_task_definition
  - aws_ecs_list_tasks
  - aws_ec2_describe_instances
  - aws_cloudwatch_get_metric_data
  - aws_cloudwatch_describe_alarms
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_health_describe_events
  - aws_cloudtrail_describe_trails
  - aws_elbv2_describe_target_health
  - aws_s3_get_bucket_policy_status
  - aws_resourcegroupstagging_get_resources
  - elasticsearch_search
  - elasticsearch_count_documents
  - gitlab_recent_deploys
  - gitlab_get_file_content
---
# AWS Infrastructure Degradation and Node Rotation

Triage ECS, EKS and node-level faults including crashlooping replicas after node rotation,
readiness probe failures and IAM authorization errors.

This is the one family where the infrastructure really is the cause, which makes it the
family where an application-side investigation wastes the most time. Prior incidents:
DEVOPS-1381, DEVOPS-1398, DEVOPS-1406.

## Symptoms
- Replicas crashlooping shortly after a node was rotated or repaired
- Readiness probe failing while the process is running
- Task replacement loop with no application exception
- Access denied on a bucket operation that worked yesterday

## Step 1: establish whether a node event preceded the fault
Use `aws_health_describe_events` for the account and region over the window, and
`aws_ec2_describe_instances` for the launch times of the instances backing the workload. A
node whose launch time sits just before the first failure reframes the whole incident.

Automated node rotation is routine and usually invisible. It becomes an incident when a
workload cannot tolerate being moved -- a stateful replica that loses its volume attachment,
or a pod that comes back before its dependency does. The node rotation is the trigger, and
the intolerance is the defect.

## Step 2: separate crashloop from probe failure
These present identically on a dashboard and are different faults.

Use `aws_ecs_describe_tasks` and `aws_ecs_list_tasks` for the stop reason and exit code. Use
`aws_logs_start_query` with `aws_logs_get_query_results` on the container log group for the
final lines before each exit.

| Evidence | Diagnosis |
|---|---|
| Non-zero exit code, stack trace in the final lines | The process is dying, a real crashloop |
| Process alive, container killed by the orchestrator | Probe failure, Step 3 |
| Exit code zero, no trace | Deliberate shutdown, usually a deploy or scale-in |

## Step 3: readiness probe failure
Use `aws_ecs_describe_task_definition` for the probe's path, interval, timeout and failure
threshold, and `aws_elbv2_describe_target_health` for what the load balancer concluded.

The recurring cause is a probe budget shorter than real startup time: a service that needs
longer to warm its caches or establish database connections than the probe allows never
becomes ready, is killed, and restarts into the same race. It looks like an unstable service
and is a configuration defect.

Use `elasticsearch_search` on the service for the startup sequence and compare the time to
first-ready against the probe threshold. Use `gitlab_recent_deploys` to check whether the
startup path recently grew a new dependency.

## Step 4: resource starvation
Use `aws_cloudwatch_get_metric_data` for CPU and memory over the window and
`aws_cloudwatch_describe_alarms` for anything already firing. Memory approaching the task
limit before each restart is an out-of-memory kill, which reports as a crashloop but is a
sizing problem. Sustained CPU at 100 percent starves I/O threads and produces downstream
timeouts that look like the dependency's fault -- see the Couchbase connectivity runbook,
where exactly this was misattributed.

## Step 5: IAM authorization failure
Use `aws_s3_get_bucket_policy_status` for the bucket's public-access and policy state, and
`aws_resourcegroupstagging_get_resources` to confirm you are looking at the resource the
service actually addresses rather than a similarly named one. Use
`aws_cloudtrail_describe_trails` to confirm a trail is recording in the region, so the
absence of a denial event means something.

An authorization error that appears without any application change is a policy, role or
trust change. Establish which of the three before escalating: the role the task assumes, the
policy attached to it, or the resource policy on the target.

## Step 6: scope the blast radius
Use `elasticsearch_count_documents` across services rather than the reporting one, and
`aws_ecs_describe_services` for the desired versus running count on neighbours sharing the
node or cluster. Infrastructure faults are rarely single-service, and a report scoped to one
service understates the incident.

Use `gitlab_get_file_content` on the workload manifest or task definition source to confirm
whether the tolerance gap (probe budget, resource request, volume claim) is declared in the
repository and therefore fixable in code.

## Cross-Datasource Correlation
- Crashloop beginning within minutes of a node launch time = rotation intolerance, not an application bug
- Probe failing while the process logs normally = probe budget, Step 3
- Memory at the task limit before each restart = out-of-memory kill, a sizing ticket
- CPU at 100 percent + downstream timeouts = the downstream is a victim, not the cause
- Access denied with no deploy in the window = a policy or role change, look outside the service repo

## Escalation Criteria
- Stateful replicas crashlooping after rotation: page, data-bearing workloads risk more than availability
- Probe budget shorter than measured startup time: raise as a configuration defect, it recurs on every deploy and every rotation
- Authorization failure with no application change: escalate to the account or platform owner, the service team cannot fix it
- Several services failing on one node: treat as an infrastructure incident and stop per-service triage

## All Tools Used Are Read-Only
aws_ecs_describe_services, aws_ecs_describe_tasks, aws_ecs_describe_task_definition, aws_ecs_list_tasks, aws_ec2_describe_instances, aws_cloudwatch_get_metric_data, aws_cloudwatch_describe_alarms, aws_logs_start_query, aws_logs_get_query_results, aws_health_describe_events, aws_cloudtrail_describe_trails, aws_elbv2_describe_target_health, aws_s3_get_bucket_policy_status, aws_resourcegroupstagging_get_resources, elasticsearch_search, elasticsearch_count_documents, gitlab_recent_deploys, gitlab_get_file_content
