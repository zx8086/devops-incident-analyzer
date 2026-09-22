---
type: Runbook
title: "Reference Data Gap (Seasons, Divisions, Sales Orgs)"
description: "Triage failures caused by missing or inactive reference data such as unregistered season codes, expired active-date windows and absent division mappings."
status: stable
tags: [reference-data, seasons, business-logic, data-quality]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - no active seasons
    - season validation
    - season not found
    - active seasons
    - isActive
    - season fetch timeout
    - division
    - salesOrg
    - reference data
    - seasons-v3
    - delivery dates
  match: any
tools:
  - capella_run_sql_plus_plus_query
  - capella_get_scopes_and_collections
  - capella_get_schema_for_collection
  - capella_get_document_by_id
  - capella_get_system_indexes
  - capella_explain_sql_plus_plus_query
  - capella_get_index_advisor_recommendations
  - elasticsearch_search
  - elasticsearch_count_documents
  - konnect_query_api_requests
  - konnect_list_plugins
  - gitlab_get_file_content
  - gitlab_get_blame
  - gitlab_recent_deploys
  - aws_logs_start_query
  - aws_logs_get_query_results
---
# Reference Data Gap (Seasons, Divisions, Sales Orgs)

Triage failures caused by missing or inactive reference data such as unregistered season
codes, expired active-date windows and absent division mappings.

This is the single most cross-cutting family in the corpus: the same missing season codes
surface as order-service exceptions, consumer dead letters and gateway 404s in different
tickets. Prior incidents: DEVOPS-1404, DEVOPS-1405, DEVOPS-1408, DEVOPS-1411, and the
upstream half of DEVOPS-1393 and DEVOPS-1397.

## Symptoms
- "The chosen brand and customer has no active seasons"
- Season validation failure on a specific order
- HTTP 404 from a seasons or delivery-dates lookup for a season/division/salesOrg triple
- Errors that cluster on a nightly batch run rather than on user traffic
- "Error getting images for season X and division Y"

## The distinction that decides everything: absent or inactive

These look identical from the application and need opposite fixes.

- **Absent**: the reference record does not exist. Someone must create it. The owning team
  is upstream, not the failing service.
- **Inactive**: the record exists but is flagged inactive or its active-date window has
  expired. This is a data-maintenance lapse, and it recurs on a calendar.

Resolve this in Step 2 before opening a ticket against any service.

## Step 1: extract the exact failing key
Use `elasticsearch_search` on the failing service for the exception and take the literal
season code, division and sales org from the message -- for example a season code, division
05 and sales org THE1. Use `aws_logs_start_query` then `aws_logs_get_query_results` on the
service's log group to confirm the same trace appears there, which rules out a log-shipping
artefact. Use `elasticsearch_count_documents` for the number of distinct orders affected;
one order is a data record, twenty-two in the same batch run is a systematic gap.

## Step 2: query the reference collection directly
Use `capella_get_scopes_and_collections` to locate the seasons or delivery-dates collection,
and `capella_get_schema_for_collection` to confirm the field names before writing a query.
Then use `capella_run_sql_plus_plus_query` to look up the exact key from Step 1, and
`capella_get_document_by_id` when the document key is known.

Read three fields on the result:
- Does a record exist at all? No record means absent.
- The active flag. False means inactive.
- The active-from and active-to dates. An active-to date in the past means the window expired.

In DEVOPS-1408 the sampled records existed, were flagged inactive and carried expired
active-to dates -- inactive, not absent, which moved the ticket to the data owner.

## Step 3: check whether the lookup can even be evaluated
Use `capella_get_system_indexes` on the collection. A missing index on the active flag means
the "active seasons" predicate cannot be evaluated efficiently or reliably, which turns a
data question into an intermittent one. Use `capella_explain_sql_plus_plus_query` on the
service's own lookup statement to see whether it falls back to a primary scan, and
`capella_get_index_advisor_recommendations` for the index it needs.

An intermittent reference-data failure with no index on the predicate is an index problem
wearing a data problem's clothes.

## Step 4: check for gateway amplification
Use `konnect_query_api_requests` on the seasons or delivery-dates route for the upstream
404 rate. Use `konnect_list_plugins` on that route: a response-caching plugin in front of a
404 converts a brief gap into a sustained platform-wide failure, and it is the difference
between a handful of failed orders and a six-figure dead-letter backlog.

## Step 5: find what introduced the dependency
Use `gitlab_recent_deploys` on the failing service around the first occurrence, and
`gitlab_get_file_content` on the service or processor that performs the lookup. Use
`gitlab_get_blame` on the lookup line. A nightly batch processor that newly calls an
existing lookup will surface a reference-data gap that was always present but never
exercised -- the commit is the trigger, the data is the cause.

## Step 6: establish the true scale before scoping
The same missing codes appear in unrelated services. Search the incident history for the
season code itself rather than for the reporting service. DEVOPS-1408's chain had five
linked prior tickets unresolved for weeks; filing a sixth against a sixth service would
have been the wrong outcome.

## Cross-Datasource Correlation
- Missing season + Kong 404s + consumer DLQ growth = one data gap, three symptoms, one ticket
- Errors confined to a nightly batch window = a scheduled processor, not user traffic
- Records exist but inactive with expired dates = data maintenance, not an application defect
- No index on the active flag + intermittent failures = index gap amplifying a data gap
- The same code failing across brands or sales orgs = upstream registration, not per-brand config

## Escalation Criteria
- Reference records absent entirely: escalate to the data-owning team; no application change will fix it
- Records inactive with expired windows: escalate as data maintenance and ask for the renewal cadence, since this recurs on a calendar
- More than five linked tickets on the same code: stop filing per-service reports and escalate the chain
- A caching plugin caching 404s on a reference route: raise as a gateway configuration defect in its own right

## All Tools Used Are Read-Only
capella_run_sql_plus_plus_query, capella_get_scopes_and_collections, capella_get_schema_for_collection, capella_get_document_by_id, capella_get_system_indexes, capella_explain_sql_plus_plus_query, capella_get_index_advisor_recommendations, elasticsearch_search, elasticsearch_count_documents, konnect_query_api_requests, konnect_list_plugins, gitlab_get_file_content, gitlab_get_blame, gitlab_recent_deploys, aws_logs_start_query, aws_logs_get_query_results
