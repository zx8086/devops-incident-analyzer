---
type: Runbook
title: "Couchbase Index and Query Plan Degradation"
description: "Diagnose non-covering index scans, lost prepared-statement reuse and KV fetch amplification that degrade a service without failing it outright."
status: stable
tags: [couchbase, index, query-plan, prepared-statements, n1ql, capacity]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - non-covering index
    - index scan
    - prepared statement
    - KV fetch
    - fetch amplification
    - query plan
    - index advisor
    - low selectivity
    - primary index scan
    - query latency
  match: any
tools:
  - capella_get_non_covering_index_queries
  - capella_get_low_selectivity_queries
  - capella_get_primary_index_queries
  - capella_get_most_expensive_queries
  - capella_get_most_frequent_queries
  - capella_explain_sql_plus_plus_query
  - capella_get_index_advisor_recommendations
  - capella_get_system_indexes
  - capella_get_detailed_indexes
  - capella_get_prepared_statements
  - capella_get_detailed_prepared_statements
  - capella_get_system_vitals
  - capella_get_scopes_and_collections
  - elasticsearch_search
  - elasticsearch_count_documents
  - konnect_query_api_requests
  - gitlab_recent_deploys
  - gitlab_get_file_content
---
# Couchbase Index and Query Plan Degradation

Diagnose non-covering index scans, lost prepared-statement reuse and KV fetch amplification
that degrade a service without failing it outright.

This family rarely arrives as its own ticket. It appears as a contributing factor inside
someone else's incident, where it widens the window in which the real fault can occur.
DEVOPS-1393 recorded it that way: average query latency of 1.335 seconds and roughly 15.4
million KV fetches per day for one sales org, alongside near-zero prepared-statement reuse,
listed as contributing beneath four other causes.

Its value is as a standing check when a service is intermittently slow and nothing is
broken. For an outright slow-query incident, use the slow query runbook instead; this one is
about the plan, not the query.

## Symptoms
- Query latency around a second where the index should make it milliseconds
- KV fetch counts far exceeding the number of documents the query should return
- Timeouts that appear only under concurrency, never in isolation
- No fatal requests, no errors, and a service that is nonetheless unwell

## Step 1: find the plans that fetch what the index should have carried
Use `capella_get_non_covering_index_queries`. A non-covering scan means the index answered
the predicate but not the projection, so every matching key triggers a KV fetch. That
amplification is the mechanism behind the fetch counts above.

Use `capella_get_primary_index_queries` for statements falling back to a full scan, and
`capella_get_low_selectivity_queries` for indexes that match far more keys than the query
returns. Low selectivity produces the same amplification through a different route.

## Step 2: confirm the plan directly
Use `capella_explain_sql_plus_plus_query` on the statements from Step 1. Read for a Fetch
phase after the index scan: its presence is the confirmation, its absence rules the query
out. This is also how a query is exonerated -- a fully covering scan with no Fetch phase is
the evidence that the statement is not the problem, which is exactly how the Couchbase
connectivity incidents ruled the query out.

Use `capella_get_index_advisor_recommendations` for the index that would cover it. An empty
recommendation set alongside a covering plan closes the question.

## Step 3: measure the amplification
Use `capella_get_system_vitals` for cumulative background-fetch time and per-bucket KV
statistics. Put a number on fetches per day and per query. A fetch count orders of magnitude
above the returned document count is the finding; latency alone is not, because latency is
what everyone already noticed.

Use `capella_get_most_expensive_queries` and `capella_get_most_frequent_queries` together. A
moderately expensive query running constantly does more damage than an expensive one running
rarely, and only the pair shows it.

## Step 4: check prepared-statement reuse
Use `capella_get_prepared_statements` and `capella_get_detailed_prepared_statements`. Near-zero
reuse means every execution re-plans, adding planning overhead to every call and discarding
the cache the cluster maintains for exactly this.

The usual cause is a client building statements by string concatenation with literal values,
so no two executions share a plan key. Use `gitlab_get_file_content` on the data-access layer
to confirm whether parameters are bound or interpolated. This is an application fix, and it
is often the cheapest improvement available.

## Step 5: audit the index set itself
Use `capella_get_system_indexes` and `capella_get_detailed_indexes` for status, definition
and build state. Use `capella_get_scopes_and_collections` to confirm the index sits on the
collection the query actually targets -- an index on a sibling collection is a common and
invisible miss.

Check for an index that exists but is not being used: a predicate whose field order does not
match the index key order will not use it, and the index will look healthy in every listing.

## Step 6: attribute it honestly
Use `elasticsearch_count_documents` on the calling service's timeout or error count and
`konnect_query_api_requests` for gateway latency on the dependent routes, to establish
whether the degradation reaches users at all.

Then decide what this is. If the service fails only under concurrency and the plan explains
the latency, it is contributing. If the service fails with the plan corrected in a test, it
is not the cause. Use `gitlab_recent_deploys` to check whether a release changed the query or
the data volume behind it. Use `elasticsearch_search` for the service's own slow-query
logging if it has any.

Listing this as a root cause when it is a contributing factor sends the wrong team the
ticket. Say which, and rank it.

## Cross-Datasource Correlation
- Non-covering scan + high KV fetch count = amplification, the mechanism behind the latency
- Near-zero prepared-statement reuse + string-built queries = application defect, cheap fix
- Fine in isolation, times out under concurrency = plan cost consuming the timeout budget
- Query latency around a second + client timeouts = plan widens the window for the real fault
- Covering plan with no Fetch phase + empty advisor output = the query is exonerated, look elsewhere

## Escalation Criteria
- KV fetches per day in the tens of millions for one caller: raise as capacity impact, it is paid for continuously
- Prepared-statement reuse near zero: raise to the owning service team, no cluster change fixes it
- An index recommended by the advisor and never created: schedule it, do not leave it in a report
- Do not report this as a root cause unless the incident reproduces with the plan corrected

## All Tools Used Are Read-Only
capella_get_non_covering_index_queries, capella_get_low_selectivity_queries, capella_get_primary_index_queries, capella_get_most_expensive_queries, capella_get_most_frequent_queries, capella_explain_sql_plus_plus_query, capella_get_index_advisor_recommendations, capella_get_system_indexes, capella_get_detailed_indexes, capella_get_prepared_statements, capella_get_detailed_prepared_statements, capella_get_system_vitals, capella_get_scopes_and_collections, elasticsearch_search, elasticsearch_count_documents, konnect_query_api_requests, gitlab_recent_deploys, gitlab_get_file_content
