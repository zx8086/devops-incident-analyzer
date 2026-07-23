---
name: fatal-request-investigation
description: Investigate fatal N1QL requests -- classify error codes (syntax vs planning vs timeout vs execution), separate self-inflicted failures from service impact, correlate with cluster health.
---

# Skill: Fatal-Request Investigation

## When to use
The incident mentions query errors or database exceptions, or another
datasource reports Couchbase errors in application logs.

## Procedure
1. `capella_get_fatal_requests(limit=20)` -- recent fatal requests with
   error messages, statements, and timings.
2. Classify each error code BEFORE reporting:
   - 3000-3999 parsing: SYNTAX bug in the issuing client -- not data, not cluster
   - 4000-4999 planning family (no-index, reprepare, alias, GSI failures):
     route by the exact message -- apply no-index-diagnosis ONLY when it
     explicitly says no index is available
   - 1080 timeout: correlate with cluster load and queue depth
   - 5000+ execution: check node memory/CPU pressure
3. Separate SELF-INFLICTED failures (this analyzer's own malformed probes,
   statements on `system:` keyspaces) from application failures -- only
   application failures are incident findings.
4. For the top failing PARSEABLE application statements, run the mandatory
   EXPLAIN + Index Advisor pass (Soul "Query optimization"). Syntax-invalid
   statements (3000-family) cannot be explained -- skip them and record the
   skip in the report.
5. Cross-check timing against `capella_get_system_vitals` /
   `capella_get_system_nodes` when they are in your current tool set (memory,
   queue depth, node status at the failure timestamps); otherwise recommend
   the system_vitals check as a follow-up instead of calling it.

## Output
Report per statement: error code and message verbatim, first/last occurrence
timestamps, occurrence count, and the classification above. Zero fatal
requests in the window is a healthy-state finding -- state it explicitly.
