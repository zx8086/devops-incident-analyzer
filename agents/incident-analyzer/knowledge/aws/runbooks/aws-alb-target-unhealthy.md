---
type: Runbook
title: "AWS Load Balancer Target Health Investigation"
description: "Diagnose unhealthy ALB/NLB targets: whether the target is failing or the health check is wrong."
status: stable
tags: [aws, elbv2, alb, networking]
generated:
  by: human:simon
  at: 2026-09-16
triggers:
  metrics:
    - target health
    - unhealthy
    - UnHealthyHostCount
    - HealthyHostCount
    - target group
    - "502"
    - "503"
    - "504"
  services:
    - elbv2
    - alb
    - ecs
  match: any
tools:
  - aws_elbv2_describe_target_groups
  - aws_elbv2_describe_target_health
  - aws_elbv2_describe_load_balancers
  - aws_elbv2_describe_listeners
  - aws_ecs_describe_services
  - aws_cloudwatch_get_metric_data
  - aws_logs_start_query
  - aws_logs_get_query_results
---

# Load balancer target health

Raised by the monitor's `targets` check when one or more targets have been
`unhealthy` across two consecutive cycles, or when a group has no healthy
targets at all. The two-cycle gate has already excluded the ordinary case: a
rolling deployment, where targets drain and register continuously.

## The question this runbook answers

An unhealthy target means the load balancer's health check did not succeed.
That has two entirely different causes, and naming the wrong one sends the fix
in the wrong direction:

1. **The target is failing.** The application is down, erroring, or too slow.
2. **The health check is wrong.** The application is fine and the check asks it
   the wrong question: wrong path, wrong port, wrong expected status, a timeout
   shorter than a cold start.

Decide which before proposing anything.

## Order of investigation

### 1. Read the reason code, not just the state

The finding carries `evidence.unhealthy[].reason`. It is the strongest single
signal available and it is already in hand; re-read current state with
`aws_elbv2_describe_target_health` only if the finding is more than a cycle old:

| Reason | Means | Points at |
|---|---|---|
| `Target.FailedHealthChecks` | The check ran and did not pass | Either cause; keep going |
| `Target.Timeout` | No response inside the timeout | Slow app, or a timeout shorter than real latency |
| `Target.ResponseCodeMismatch` | It responded, with the wrong status | Almost always the check config, not the app |
| `Target.NotRegistered` | Target is gone | Scaling or a replaced task |
| `Target.NotInUse` | Group not attached to a listener | Configuration, not health |
| `Elb.InternalError` | Load balancer side | AWS Health, not the workload |
| `Elb.RegistrationInProgress` | Still registering | Transient; not a fault |

`Target.ResponseCodeMismatch` deserves its own note: the target is up and
answering. Check `evidence.healthCheck.matcher` against what the path actually
returns before touching the application. A service that answers `/health` with
`200` under a matcher expecting `200-299` is fine; one answering `302` because
the health path redirects to a login page is a check that was never right.

### 2. Establish whether this is partial or total

`evidence.healthyCount` against `evidence.settledCount` decides the severity
and the urgency. For how long it has been this way, read `HealthyHostCount`
for the target group with `aws_cloudwatch_get_metric_data`, which also
separates a sudden drop from a slow bleed:

- **Zero healthy** is an outage: the group is serving nothing and the listener
  returns 503 to every request. Say so plainly in the diagnosis.
- **Some healthy** is degraded capacity. Establish whether the remaining
  targets can carry the load before calling it an incident.

If exactly one target of many is unhealthy and the rest are fine, the target
is far more likely at fault than the check, which is common to all of them.
This is the single most useful piece of reasoning in this runbook: a check
misconfiguration fails every target, a bad instance fails one.

### 3. Check the health-check settings against reality

The finding carries the whole `healthCheck` block, so this costs no call; use
`aws_elbv2_describe_target_groups` if you need the current values rather than
the ones at detection time. Compare:

- `path` against a path the application actually serves
- `port` against the container or listener port, watching for `traffic-port`
- `timeoutSeconds` against the application's real p99 latency
- `intervalSeconds` and `unhealthyThreshold` against how long a cold start
  takes; a container needing 40 s to warm up under a 10 s interval and a
  threshold of 2 will never pass

### 4. Then, and only then, look at the application

If the check looks correct, go to the target. For an ECS target group resolve
the service with `aws_ecs_describe_services`, then read the task's log group
from its task definition rather than guessing the name. Query it with
`aws_logs_start_query` and `aws_logs_get_query_results` over the window around
the first unhealthy timestamp in the finding, not a fixed recent window.

If the symptom reported by users is a 503 rather than an unhealthy target,
confirm the listener actually routes to this group: `aws_elbv2_describe_listeners`
for the rules, and `aws_elbv2_describe_load_balancers` for the balancer's own
state and scheme. A group with no healthy targets behind a listener rule is
exactly what returns 503.

### 5. If the target is healthy in isolation but unhealthy to the balancer

This is a network path problem, not an application problem. The security group
on the target must allow the load balancer's security group on the health
check port, and the NACL must allow the return traffic on ephemeral ports.
Trace the path hop by hop rather than inspecting the security group alone: a
NACL denial on return traffic is invisible in security group rules.

## Reporting

State which of the two causes it is, and cite the evidence that decided it:
the reason code plus either the health check setting that is wrong or the
application error that explains the failure. "Targets are unhealthy" restates
the finding and is not a diagnosis.

Never claim recovery from a single passing check; the balancer requires
`healthyThreshold` consecutive successes.

## All Tools Used Are Read-Only
aws_elbv2_describe_target_groups, aws_elbv2_describe_target_health, aws_elbv2_describe_load_balancers, aws_elbv2_describe_listeners, aws_ecs_describe_services, aws_cloudwatch_get_metric_data, aws_logs_start_query, aws_logs_get_query_results

---

Source: health-check failure-mode tables adapted from the AWS Agent Toolkit
`aws-compute` and `aws-containers` skills (github.com/aws/agent-toolkit-for-aws,
Apache-2.0, Copyright Amazon.com, Inc. or its affiliates).
