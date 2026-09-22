---
type: Runbook
title: "External System Integration Failure"
description: "Triage failures at the boundary with SAP, Boomi and other external systems, where the fault sits outside the observable estate."
status: stable
tags: [integration, sap, boomi, external, order-submission]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - SAP order submission
    - SAP
    - Boomi
    - order submission 500
    - external system
    - integration failure
    - connection pool exhaustion
    - downstream 500
    - RISE
  match: any
tools:
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_esql_query
  - konnect_query_api_requests
  - konnect_get_service
  - konnect_list_plugins
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_cloudwatch_get_metric_data
  - aws_ec2_describe_vpc_endpoints
  - aws_route53_list_resource_record_sets
  - gitlab_get_file_content
  - gitlab_recent_deploys
  - capella_get_document_by_id
---
# External System Integration Failure

Triage failures at the boundary with SAP, Boomi and other external systems, where the fault
sits outside the observable estate.

The defining constraint: the far side is not instrumented here. Every conclusion must be
built from what the boundary shows, and the report must be explicit about where observation
stops. Prior incidents: DEVOPS-1376, DEVOPS-1395, DEVOPS-1431.

## Symptoms
- HTTP 500 returned by an external system on order or document submission
- Connection pool exhaustion on an integration runtime
- A downstream system unreachable after a name-resolution failure, staying unreachable after
  it recovers
- Failures concentrated on specific payload shapes rather than on volume

## Step 1: capture the boundary exchange, both directions
Use `elasticsearch_search` on the calling service for the request and the response body, and
`aws_logs_start_query` with `aws_logs_get_query_results` on its log group for anything the
APM trace truncated.

Record four things before analysing anything: the request payload shape, the exact response
status and body, the elapsed time, and whether the call was retried. An external 500 with a
body is far more informative than the status alone, and it is the only view of the far side
that exists.

## Step 2: decide whether the request ever arrived
Use `konnect_query_api_requests` on the egress route and `konnect_get_service` for the
upstream definition. Use `aws_ec2_describe_vpc_endpoints` when the integration runs over
PrivateLink and `aws_route53_list_resource_record_sets` to confirm the hostname resolves to
what you expect.

| Evidence | Diagnosis |
|---|---|
| Response body from the far system | It arrived and was rejected, Step 3 |
| Connection error or timeout, no body | It may never have arrived, Step 4 |
| Immediate reset | Network path or endpoint, Step 4 |

## Step 3: rejected by the far system
Use `elasticsearch_esql_query` to group failures by payload attribute -- customer, order
type, season, document shape. Concentration on an attribute means the far system is
rejecting a specific data condition, which is a contract question, not an availability one.

Use `capella_get_document_by_id` to fetch the source record behind a failing submission and
compare it against a succeeding one. The difference between the two is the finding.

Use `gitlab_get_file_content` on the mapping or client code and `gitlab_recent_deploys` to
check whether the payload shape changed on our side. A mapping change that the far system
never agreed to produces exactly this signature.

State plainly in the report that the far system's own logs were not available, and what
would be needed from its owner to close the question.

## Step 4: never arrived, or a stale connection path
Use `aws_cloudwatch_get_metric_data` for connection counts and errors on the integration
runtime, and `konnect_list_plugins` on the route for retry and timeout policy.

The pattern worth naming: a client that caches connection or routing state does not recover
when the far side does. A name-resolution failure puts the client into a reroute state that
survives the outage, so the system stays unreachable long after the cause is gone and every
infrastructure check reads healthy. If the outage window and the failure window do not match,
suspect cached state in the client rather than a continuing fault.

Connection pool exhaustion belongs here too: the pool is ours, the latency causing it is
theirs. Report both halves.

## Step 5: distinguish sustained from transient
Use `elasticsearch_count_documents` over the window and over a baseline, and plot onset and
recovery. Three shapes and three different tickets:
- Sharp onset, sharp recovery: a far-side outage, record it and close
- Sharp onset, no recovery: cached client state, Step 4, needs a restart or a fix
- Gradual onset tracking volume: capacity on the far side or in our pool

## Step 6: write the boundary into the report
Name which systems were observable and which were not. An incident report that implies the
external system was examined when only our side was will mislead whoever reads it next. If
the conclusion depends on the far system's behaviour, say that it is inferred from the
boundary and name the evidence it rests on.

## Cross-Datasource Correlation
- External 500 concentrated on one payload attribute = contract or data condition, not availability
- Failure window outliving the outage window = cached client state, restart proves it
- Pool exhaustion + rising far-side latency = their latency, our pool, both belong in the report
- Egress route healthy + no far-side body = the request likely never arrived
- Payload mapping change on our side in the same window = our defect, check first before escalating outward

## Escalation Criteria
- Far system returning 500 on valid payloads: escalate to its owner with the exact request and response captured, and say our logs end at the boundary
- Client stuck in a stale connection state: recovery needs an intervention on our side, do not wait for the far system
- Repeated integration failures with no far-side visibility: raise the observability gap as its own item, it will block the next incident too
- Do not attribute a root cause to an external system on timing alone; say inferred, and name what would confirm it

## All Tools Used Are Read-Only
elasticsearch_search, elasticsearch_count_documents, elasticsearch_esql_query, konnect_query_api_requests, konnect_get_service, konnect_list_plugins, aws_logs_start_query, aws_logs_get_query_results, aws_cloudwatch_get_metric_data, aws_ec2_describe_vpc_endpoints, aws_route53_list_resource_record_sets, gitlab_get_file_content, gitlab_recent_deploys, capella_get_document_by_id
