---
type: Runbook
title: "Throughput Spike and Log Volume Surge"
description: "Triage sudden traffic or log-volume increases and separate genuine demand from retry storms and log flooding."
status: stable
tags: [throughput, log-volume, traffic-spike, retry-storm, observability-cost]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - throughput spike
    - traffic spike
    - log flooding
    - log volume
    - high volume
    - error rate spike
    - request surge
    - ingest volume
    - retry storm
  match: any
tools:
  - elasticsearch_count_documents
  - elasticsearch_search
  - elasticsearch_esql_query
  - elasticsearch_indices_summary
  - elasticsearch_get_index_info
  - elasticsearch_disk_usage
  - elasticsearch_ml_get_anomaly_records
  - elasticsearch_ml_list_jobs
  - konnect_query_api_requests
  - konnect_list_routes
  - konnect_get_route
  - konnect_list_plugins
  - aws_cloudwatch_get_metric_data
  - aws_ecs_describe_services
  - aws_logs_start_query
  - aws_logs_get_query_results
  - gitlab_recent_deploys
  - gitlab_get_file_content
---
# Throughput Spike and Log Volume Surge

Triage sudden traffic or log-volume increases and separate genuine demand from retry storms
and log flooding.

The question is never "is volume up". It is whether the volume is work the platform was
asked to do. Prior incidents: DEVOPS-1380, DEVOPS-1386, DEVOPS-1387, DEVOPS-1388.

## Symptoms
- Request rate or log event count far above baseline with no announced campaign
- Daily log events in the tens of millions from one service
- Elasticsearch ingest cost or disk growth flagged before any user-visible failure
- A spike whose shape is flat rather than diurnal

## Step 1: quantify against a baseline, not against zero
Use `elasticsearch_count_documents` for the window and for an equivalent quiet period, and
report the multiplier. Use `elasticsearch_esql_query` to break the count down by service, by
log level and by message template. Use `elasticsearch_ml_list_jobs` and
`elasticsearch_ml_get_anomaly_records` to confirm the platform's own anomaly detection
agrees the window is abnormal rather than seasonal.

A spike without a stated baseline is not a finding.

## Step 2: the decisive split, demand or self-inflicted
Group by message template in Step 1 and read the distribution.

| Distribution | Diagnosis | Go to |
|---|---|---|
| Spread across many templates, tracks request rate | Genuine demand | Step 3 |
| Dominated by one or two templates | Log flooding | Step 4 |
| Dominated by error or retry templates | Retry storm | Step 5 |

In DEVOPS-1380 a single service emitted 22.5 to 22.6 million daily events; that
concentration is the signature of Step 4, and no amount of capacity work would have been
the right answer.

## Step 3: genuine demand
Use `konnect_query_api_requests` for the gateway-side request rate on the affected routes,
and `konnect_list_routes` to confirm which routes carry the increase. Use
`aws_cloudwatch_get_metric_data` for CPU, memory and task count, and
`aws_ecs_describe_services` for desired versus running count, to establish whether capacity
actually absorbed the demand.

Genuine demand that the platform served is not an incident. Report headroom and close it.
Genuine demand that saturated the service is a capacity ticket.

## Step 4: log flooding
Use `elasticsearch_search` to retrieve examples of the dominant template and
`elasticsearch_get_index_info` plus `elasticsearch_indices_summary` for the index growth it
caused. Use `elasticsearch_disk_usage` to put a storage figure on it.

Then find the emitter. Use `gitlab_recent_deploys` on the service around the onset, and
`gitlab_get_file_content` on the class in the message to check the log level. The recurring
causes are a debug or info statement left inside a hot loop, a library default raised by a
dependency bump, and an exception logged at every layer as it propagates.

The fix is a log level or a sampling rule, not cluster capacity. Report the ingest cost,
because that is the actual damage.

## Step 5: retry storm
Use `aws_logs_start_query` and `aws_logs_get_query_results` to count attempts per unique
request id. Retries multiply a small fault into a large one and make the spike look like
demand from every angle except this one.

Use `konnect_list_plugins` on the affected route to check retry and timeout policy at the
gateway: a gateway retry stacked on a client retry multiplies rather than adds. Use
`konnect_get_route` for the route's upstream timeout. A timeout shorter than the real
upstream latency generates a guaranteed retry storm under load.

Fix the originating fault first. Tuning retry counts without fixing the cause only changes
the rate of failure.

## Step 6: state the user impact explicitly
A volume finding needs an impact statement or it will be actioned wrongly. Use
`konnect_query_api_requests` for the error rate and latency on the affected routes during
the window. High volume with flat error rate and flat latency is a cost incident. High
volume with elevated errors is an availability incident. Say which.

## Cross-Datasource Correlation
- Volume up + error rate flat + latency flat = cost incident, not availability
- One message template dominating = log flooding, find the emitter
- Attempts per request id above one = retry storm, fix the origin fault
- Spike starting at a deployment boundary = release-introduced, check log level changes
- Gateway request rate flat while log volume is up = self-inflicted, the traffic never changed

## Escalation Criteria
- Sustained log volume above ten million daily events from one service: raise as ingest cost with the storage figure attached
- Retry storm confirmed with gateway and client retries stacked: escalate the retry policy as its own defect
- Genuine demand saturating capacity: capacity ticket with the headroom figures, not an application bug
- Do not recommend raising cluster capacity for a flooding incident; it pays for the defect indefinitely

## All Tools Used Are Read-Only
elasticsearch_count_documents, elasticsearch_search, elasticsearch_esql_query, elasticsearch_indices_summary, elasticsearch_get_index_info, elasticsearch_disk_usage, elasticsearch_ml_get_anomaly_records, elasticsearch_ml_list_jobs, konnect_query_api_requests, konnect_list_routes, konnect_get_route, konnect_list_plugins, aws_cloudwatch_get_metric_data, aws_ecs_describe_services, aws_logs_start_query, aws_logs_get_query_results, gitlab_recent_deploys, gitlab_get_file_content
