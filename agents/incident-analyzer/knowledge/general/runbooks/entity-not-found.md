---
type: Runbook
title: "Entity Not Found and Stale Reference"
description: "Triage 404 and not-found exceptions for entities that were archived, removed or never created, and separate them from routing fallthrough."
status: stable
tags: [not-found, "404", stale-data, routing, entity]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - NotFoundWithDetailsException
    - NoResourceFoundException
    - EntityNotFoundException
    - DocumentNotFoundException
    - not found
    - "404"
    - archived variant
    - removed variant
    - stale reference
  match: any
tools:
  - capella_get_document_by_id
  - capella_run_sql_plus_plus_query
  - capella_get_scopes_and_collections
  - capella_analyze_document_structure
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_esql_query
  - konnect_query_api_requests
  - konnect_get_route
  - konnect_list_routes
  - gitlab_recent_deploys
  - gitlab_get_merge_request_diffs
  - gitlab_get_file_content
  - aws_ecs_describe_task_definition
  - aws_logs_start_query
  - aws_logs_get_query_results
---
# Entity Not Found and Stale Reference

Triage 404 and not-found exceptions for entities that were archived, removed or never
created, and separate them from routing fallthrough.

A not-found is three different incidents wearing one status code. Prior incidents:
DEVOPS-1390, DEVOPS-1400, DEVOPS-1402, DEVOPS-1403.

## Symptoms
- `NotFoundWithDetailsException` or `DocumentNotFoundException` naming a specific entity id
- `NoResourceFoundException` with no entity id at all
- `EntityNotFoundException` from a service layer during an assignment or lookup
- A steady low-rate 404 background that nobody owns

## Step 1: the three-way split
Answer this first; the three branches have nothing in common except the status code.

| Evidence | Diagnosis | Go to |
|---|---|---|
| The exception names an entity id | The caller holds a stale reference | Step 2 |
| No entity id, and the path does not match any handler | Routing fallthrough | Step 3 |
| The entity id exists but the caller cannot see it | Scope, tenancy or permission | Step 4 |

`NoResourceFoundException` in particular is usually Step 3, not Step 2 -- it is the
framework saying no route matched, which a deployment can introduce.

## Step 2: stale reference to an archived or removed entity
Use `capella_get_document_by_id` for the exact id from the exception. Absent confirms
removal. Use `capella_run_sql_plus_plus_query` to check whether a soft-delete or archive
flag exists on the collection and whether the record carries it -- an archived record that
is still present reads as "found" to the database and "not found" to a service that filters
on the flag, which is the most misdiagnosed case here.

Use `capella_get_scopes_and_collections` and `capella_analyze_document_structure` when the
field names are unknown, rather than guessing at the schema.

Then answer why the caller still holds the reference. Use `elasticsearch_search` on the
calling service and check whether the id came from a cache, a stale index, or an event
consumed before the deletion propagated. The fix belongs wherever the stale reference is
produced, not at the point that fails.

## Step 3: routing fallthrough
Use `gitlab_recent_deploys` on the service around the first occurrence and
`aws_ecs_describe_task_definition` to identify the revision in service at that time. Use
`gitlab_get_merge_request_diffs` on the release to look specifically for changes to route
annotations, path prefixes or a catch-all handler. A path that quietly stopped matching
produces a constant 404 rate that begins at a deployment boundary and never recovers.

Use `konnect_list_routes` and `konnect_get_route` to confirm what the gateway believes the
path to be, then `konnect_query_api_requests` for the 404 rate on that route. A gateway
route pointing at a path the service no longer serves is the same defect seen from the
other side.

## Step 4: visible to the database, invisible to the caller
Use `elasticsearch_search` for the calling user or tenant on the failing request, and
`aws_logs_start_query` with `aws_logs_get_query_results` for the authorization decision in
the service log. Use `gitlab_get_file_content` on the lookup to read the filter it applies.
An entity that exists but is out of the caller's scope should not be reported as an
infrastructure incident.

## Step 5: separate the background rate from the incident
Use `elasticsearch_count_documents` for the 404 count over the incident window and over a
quiet baseline window, and `elasticsearch_esql_query` to break the count down by path and by
entity id. Two distinct shapes:
- Many failures on few distinct ids = a hot stale reference, usually a cache or a consumer
- Few failures on many distinct ids = normal churn, likely not an incident at all

Report the baseline alongside the incident figure. A 404 rate that was always there is a
backlog item, not a page.

## Cross-Datasource Correlation
- Not-found beginning exactly at a deployment boundary = routing fallthrough, Step 3
- Not-found with entity ids that all resolve to archived records = propagation lag from the deleting system
- Gateway 404s with no matching service-side exception = the request never reached the service
- One id repeating thousands of times = a cached or replayed reference, fix the producer
- Constant low-rate 404s across many ids with no trend = background churn, not the incident

## Escalation Criteria
- Routing fallthrough confirmed: treat as a release defect and consider rollback, since every caller of that path is affected
- Stale references traced to an event consumer: escalate to the producing service, the consumer cannot fix propagation order
- Entity exists but is out of scope: close as working-as-designed with the authorization evidence, do not file infrastructure work
- A 404 rate that predates the reported window: correct the ticket's framing before proposing any fix

## All Tools Used Are Read-Only
capella_get_document_by_id, capella_run_sql_plus_plus_query, capella_get_scopes_and_collections, capella_analyze_document_structure, elasticsearch_search, elasticsearch_count_documents, elasticsearch_esql_query, konnect_query_api_requests, konnect_get_route, konnect_list_routes, gitlab_recent_deploys, gitlab_get_merge_request_diffs, gitlab_get_file_content, aws_ecs_describe_task_definition, aws_logs_start_query, aws_logs_get_query_results
