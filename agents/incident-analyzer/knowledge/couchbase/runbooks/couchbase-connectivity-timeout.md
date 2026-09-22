---
type: Runbook
title: "Couchbase Connectivity and Request Timeout"
description: "Triage Couchbase KV and Query timeouts, cancelled in-flight requests and refused connections against the Capella private endpoint."
status: stable
tags: [couchbase, connectivity, timeout, capella, privatelink]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - couchbase timeout
    - unambiguous timeout
    - ambiguous timeout
    - request cancelled
    - RequestCanceledException
    - UnambiguousTimeoutException
    - CHANNEL_CLOSED_WHILE_IN_FLIGHT
    - ENDPOINT_NOT_WRITABLE
    - connection refused
    - GetRequest timeout
    - QueryRequest timeout
    - orphan response
    - capella
    - private endpoint
  match: any
tools:
  - capella_ping
  - capella_get_cluster_health
  - capella_get_system_vitals
  - capella_get_system_nodes
  - capella_get_cluster_diagnostics_report
  - capella_get_fatal_requests
  - capella_get_completed_requests
  - capella_get_buckets
  - capella_explain_sql_plus_plus_query
  - capella_get_index_advisor_recommendations
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_cloudwatch_get_metric_data
  - aws_ecs_describe_services
  - aws_ecs_describe_tasks
  - aws_ec2_describe_vpc_endpoints
  - aws_ec2_describe_network_interfaces
  - aws_ec2_describe_security_groups
  - aws_ec2_describe_flow_logs
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_ml_get_anomaly_records
  - konnect_query_api_requests
---
# Couchbase Connectivity and Request Timeout

Triage Couchbase KV and Query timeouts, cancelled in-flight requests and refused
connections against the Capella private endpoint.

This family recurs on `pvh-services-styles-v3` against Capella cluster
`mn1uxqblvorb0cle` at a cadence of every 1-3 days. Four prior incidents share the
mechanism: DEVOPS-1353, DEVOPS-1375, DEVOPS-1407, DEVOPS-1412, DEVOPS-1413.

## Symptoms
- `UnambiguousTimeoutException` or `AmbiguousTimeoutException` on KV `GetRequest`
- `RequestCanceledException` with reason `CHANNEL_CLOSED_WHILE_IN_FLIGHT` or `ENDPOINT_NOT_WRITABLE`
- Connections to Query TLS port 18093 refused instantly (TCP RST, ~0.01s) while KV 11207 stays clean
- Application error burst visible in APM with no matching Couchbase server-side fatal requests
- Elapsed time far below the configured SDK timeout (for example 5.1-5.9s elapsed against a 75,000ms budget)

## The decisive question: client-side stall or server-side fault

Three prior incidents were misdiagnosed as Couchbase faults before this split was made.
Answer it first, because it selects which half of the runbook applies.

Use `aws_logs_start_query` then `aws_logs_get_query_results` against the application log
group to extract the Couchbase SDK's own orphan-response telemetry. Compare two fields on
the same records:

- "total_server_duration_us" -- how long Couchbase took to answer
- "dispatch_duration_us" -- how long the request spent in the client's dispatch path

| Observation | Meaning | Go to |
|---|---|---|
| server 3-27us, dispatch 1.1-3.3s | Server answered instantly; delay is client-side or in transit | Section A |
| server duration high, dispatch low | Genuine server-side slowness | Section B |
| No orphan records at all | SDK never got far enough to report; suspect connection refusal | Section C |

A count of orphaned requests per window is the severity signal: 628-2,730 per 10-second
window was observed in DEVOPS-1412.

## Section A: client-side stall (most common)

The SDK's Netty I/O and timer threads are starved, so responses arrive but are not
processed inside the timeout budget.

### A1. Check ECS task CPU saturation
Use `aws_cloudwatch_get_metric_data` for "CPUUtilization" on the service's ECS tasks across
the incident window. Sustained 100 percent is the confirmed cause in DEVOPS-1413. Use
`aws_ecs_describe_services` for the desired versus running count and `aws_ecs_describe_tasks`
for per-task health, to distinguish saturation from a task that was replaced mid-window.

### A2. Confirm the server was healthy at the same moment
Use `capella_ping` for a direct per-service reachability check, `capella_get_cluster_health`
for per-service ping latency and `capella_get_system_nodes` to confirm all KV nodes report
healthy. Single-digit to low-tens-of-ms KV ping latency
during the window rules the server out. Use `capella_get_fatal_requests` -- zero fatal N1QL
requests during the window is corroborating evidence that the cluster was fine, and
`capella_get_completed_requests` to compare the latency distribution of the requests that
did succeed against the SDK budget.

### A3. Quantify the application-side burst
Use `elasticsearch_count_documents` on the service's error index for the window to get the
multiplier against baseline (a 33x spike and 5,375 events in one minute were observed).
Use `elasticsearch_ml_get_anomaly_records` for the `apm-high-mean-response-time` and
`apm-errors-high-rate-by-service` jobs to confirm the burst is anomalous rather than
diurnal.

## Section B: server-side pressure

### B1. Read the cluster vitals
Use `capella_get_system_vitals`. The fields that matter for this family:
- "bucket.IO.stats.<bucket>.retries" -- values in the hundreds of thousands indicate storage or network-side pressure
- cumulative background-fetch time -- large values indicate the KV service is working, not idle
- FFDC fault records per node -- direct evidence of query-service-side instability

Use `capella_get_buckets` to confirm which bucket carries the affected collections, and
`capella_get_cluster_diagnostics_report` for a consolidated per-endpoint socket state when
the vitals are ambiguous.

### B2. Check query-service latency specifically
Use `capella_get_cluster_health` and read query-service ping latency separately from KV.
Query ping latency of 264,000-280,000ms against normal single-digit ms (DEVOPS-1407) is a
query-service channel disruption, not a client problem.

### B3. Rule the query itself in or out
Use `capella_explain_sql_plus_plus_query` on the statement the service runs. A fully
covering index scan with no Fetch phase rules the query out as a contributing cause. Use
`capella_get_index_advisor_recommendations`; an empty recommendation set confirms it.

## Section C: connections refused at the endpoint

### C1. Establish which port and which AZ
Refusals that return instantly are a TCP RST, not a timeout. In DEVOPS-1375 Query TLS 18093
refused 16-23 of 50 attempts across all three AZ endpoint ENIs while KV TLS 11207 control
was 50/50 clean.

### C2. Prove the reset originates beyond the PVH boundary
Use `aws_ec2_describe_vpc_endpoints` for the endpoint and its service name, and
`aws_ec2_describe_network_interfaces` for the per-AZ endpoint ENIs. Use
`aws_ec2_describe_security_groups` for the endpoint SG and the client SGs, and
`aws_ec2_describe_flow_logs` to confirm flow logs are enabled. Flow logs recording ACCEPT
through the endpoint ENIs followed by a reset place the RST on the Capella-managed NLB
behind the endpoint service, not at the PVH SG, NACL or endpoint layer.

### C3. Measure the blast radius before escalating
A Capella-side endpoint fault is multi-service by nature. Use `konnect_query_api_requests`
on routes backed by Couchbase, and `elasticsearch_search` across services rather than the
single reporting service. DEVOPS-1375 found 4.8M occurrences across five services
(customer-assignments, pvh-services-styles-v3, prices-api-v2, brads, storytelling-api) --
scope that was invisible from the originating ticket alone.

## Check for a known recurrence before writing a new diagnosis
Use the linked-incident lookup on the affected service. This family has five prior reports, and
the cadence means a new occurrence is usually the same fault rather than a new one. Note
the default lookup window is narrow; this family has needed a widened window to surface its
own history.

## Cross-Datasource Correlation
- Couchbase healthy + ECS CPU 100 percent + client timeouts = client-side stall, Section A
- server_duration microseconds + dispatch_duration seconds = transit or dispatch, never the server
- Instant TCP RST on 18093 + clean 11207 control = Capella-side endpoint fault, Section C
- Error burst across several unrelated services = infrastructure layer, not application code
- Kafka connector lag alongside these timeouts is usually a downstream symptom, not a cause

## Escalation Criteria
- RST confirmed originating beyond the endpoint ENIs: escalate to Couchbase Capella support with the per-AZ connect/refuse counts and the flow-log evidence
- Query-service ping latency above 60,000ms: page on-call, the cluster is not serving
- Recurrence within 72 hours of a closed ticket in this family: reopen the parent rather than filing a new report
- Sustained ECS CPU at 100 percent: the fix is capacity or a client-side profile, not a Couchbase ticket

## All Tools Used Are Read-Only
capella_ping, capella_get_cluster_health, capella_get_system_vitals, capella_get_system_nodes, capella_get_cluster_diagnostics_report, capella_get_fatal_requests, capella_get_completed_requests, capella_get_buckets, capella_explain_sql_plus_plus_query, capella_get_index_advisor_recommendations, aws_logs_start_query, aws_logs_get_query_results, aws_cloudwatch_get_metric_data, aws_ecs_describe_services, aws_ecs_describe_tasks, aws_ec2_describe_vpc_endpoints, aws_ec2_describe_network_interfaces, aws_ec2_describe_security_groups, aws_ec2_describe_flow_logs, elasticsearch_search, elasticsearch_count_documents, elasticsearch_ml_get_anomaly_records, konnect_query_api_requests
