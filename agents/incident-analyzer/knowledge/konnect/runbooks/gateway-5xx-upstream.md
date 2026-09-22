---
type: Runbook
title: "API Gateway 5xx and Upstream Timeout"
description: "Triage Kong 502, 503 and 504 responses and attribute them to the gateway, the upstream service or the timeout budget between them."
status: stable
tags: [konnect, kong, gateway, 5xx, timeout, upstream]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - "504"
    - "503"
    - "502"
    - gateway timeout
    - service unavailable
    - upstream timeout
    - kong
    - konnect
    - bad gateway
    - graphql error surge
  match: any
tools:
  - konnect_query_api_requests
  - konnect_get_route
  - konnect_list_routes
  - konnect_get_service
  - konnect_list_services
  - konnect_list_plugins
  - konnect_get_plugin
  - konnect_list_data_plane_nodes
  - konnect_get_control_plane
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_esql_query
  - aws_elbv2_describe_target_health
  - aws_elbv2_describe_target_groups
  - aws_ecs_describe_services
  - aws_ecs_describe_tasks
  - aws_cloudwatch_get_metric_data
  - gitlab_recent_deploys
---
# API Gateway 5xx and Upstream Timeout

Triage Kong 502, 503 and 504 responses and attribute them to the gateway, the upstream
service or the timeout budget between them.

The status code already narrows the cause; most of the misdiagnoses in this family come
from treating all three as one symptom. Prior incidents: DEVOPS-1385, DEVOPS-1391,
DEVOPS-1419.

## Symptoms
- 504 Gateway Timeout on a specific route, often a GraphQL or order endpoint
- 503 Service Temporarily Unavailable, sometimes for one named user
- 502 Bad Gateway in bursts
- An error surge visible at the gateway with no matching upstream exception

## Step 1: read the code, it is the first branch

| Code | Meaning | Most likely cause | Go to |
|---|---|---|---|
| 504 | Upstream did not answer within the route's timeout | Slow upstream, or a timeout shorter than real latency | Step 2 |
| 503 | No healthy upstream target available | Target health, deploy, or scale-to-zero | Step 3 |
| 502 | Upstream answered with something unusable | Connection reset, protocol mismatch, upstream crash | Step 4 |

Use `konnect_query_api_requests` on the affected route for the per-code breakdown over the
window; a mix of codes usually means two faults, not one.

## Step 2: 504, the timeout budget
Use `konnect_get_route` for the route's read and connect timeout, and `konnect_get_service`
for the service-level timeout. Then use `elasticsearch_esql_query` on the upstream service's
traces for the latency distribution over the same window.

Compare the configured timeout against the upstream p95 and p99. The three outcomes:
- Upstream p99 above the timeout: the budget is wrong, or the upstream regressed
- Upstream p99 well below the timeout: the request never reached the upstream, go to Step 3
- Upstream latency rising through the window: a downstream dependency, follow it

Use `konnect_list_plugins` on the route and check for a retry policy stacked on top of the
timeout. A retry inside a client timeout guarantees a 504 under load rather than preventing
one.

## Step 3: 503, no healthy target
Use `aws_elbv2_describe_target_health` for the target group behind the upstream and
`aws_elbv2_describe_target_groups` for the health-check configuration. Use
`aws_ecs_describe_services` for desired versus running count and `aws_ecs_describe_tasks`
for per-task state.

A health check that is stricter than the application's real readiness produces 503s while
the service is in fact serving. Check the interval, threshold and path before concluding
the service is down.

Use `konnect_list_data_plane_nodes` and `konnect_get_control_plane` to confirm the data
plane itself is connected; a disconnected node produces 503s that have nothing to do with
the upstream at all.

For a 503 affecting one named user, use `elasticsearch_search` filtered to that user. A
single-user 503 is usually a consumer or rate-limit configuration, not an outage. Use
`konnect_get_plugin` on the rate-limiting plugin to read its thresholds.

## Step 4: 502, unusable response
Use `elasticsearch_search` on the upstream service for crashes, connection resets or
out-of-memory events in the window, and `aws_cloudwatch_get_metric_data` for memory and CPU
on the tasks. A 502 burst that matches task restarts is the upstream dying mid-response.

Use `gitlab_recent_deploys` to check for a release at the onset. A protocol or payload
change between gateway and upstream shows up as a 502 that starts exactly at a deployment.

## Step 5: confirm the direction of causation
Use `konnect_query_api_requests` for the gateway-side error count and
`elasticsearch_count_documents` for the upstream-side exception count over the same window.

- Gateway errors far exceeding upstream exceptions: the requests are failing before or
  between, not inside the upstream
- Both counts matching: the upstream is genuinely failing and the gateway is reporting it
- Upstream exceptions with no gateway errors: the failures are not on the gateway path

Use `konnect_list_services` and `konnect_list_routes` to confirm the route actually maps to
the upstream you are measuring, before trusting any of the above.

## Cross-Datasource Correlation
- 504 + upstream p99 under the configured timeout = the request never arrived, check targets
- 503 + healthy ECS tasks = health-check configuration, not availability
- 502 burst + task restarts in the same minute = upstream crash loop
- Gateway 5xx across several unrelated routes = data plane or control plane, not any one service
- 503 for one user only = consumer or rate-limit configuration

## Escalation Criteria
- Data plane nodes disconnected from the control plane: page, every route is affected
- Upstream p99 above the route timeout and rising: the upstream owner owns the fix, raise there with the latency evidence
- Health check stricter than real readiness: raise as a configuration defect, it will recur on every deploy
- Retry stacked inside a timeout budget: raise as its own defect, it converts slow into failed

## All Tools Used Are Read-Only
konnect_query_api_requests, konnect_get_route, konnect_list_routes, konnect_get_service, konnect_list_services, konnect_list_plugins, konnect_get_plugin, konnect_list_data_plane_nodes, konnect_get_control_plane, elasticsearch_search, elasticsearch_count_documents, elasticsearch_esql_query, aws_elbv2_describe_target_health, aws_elbv2_describe_target_groups, aws_ecs_describe_services, aws_ecs_describe_tasks, aws_cloudwatch_get_metric_data, gitlab_recent_deploys
