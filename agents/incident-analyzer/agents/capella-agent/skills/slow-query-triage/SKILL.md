---
name: slow-query-triage
description: Ordered workflow for database-latency incidents -- windowed triage of expensive/longest-running queries, top-N selection by impact, then the mandatory EXPLAIN + Index Advisor pass.
---

# Skill: Slow-Query Triage

## When to use
The incident mentions database latency, slow endpoints backed by Couchbase,
or query timeouts (fatal errors go to fatal-request-investigation instead).

## Procedure
1. Scope the window FIRST. Pass `period` matching the incident window
   (`day` for an active incident, `week`/`month` for trends) and a small
   `limit` instead of accepting defaults:
   - `capella_get_most_expensive_queries(period="day", limit=10)` -- cumulative
     resource cost (defaults: 8-week window, limit 50)
   - `capella_get_longest_running_queries(limit=10)` -- latency outliers
   - `capella_get_most_frequent_queries(limit=10)` -- volume-driven degradation
2. Pick the top 1-3 APPLICATION statements by impact (`sum_serviceTime`,
   `avg_elapsedTime`, `count`). Skip `system:` keyspace statements and this
   analyzer's own probes.
3. MANDATORY before reporting (Soul "Query optimization"): run
   `capella_explain_sql_plus_plus_query` and
   `capella_get_index_advisor_recommendations` on each selected statement;
   cite plan operators as evidence and include advisor DDL verbatim as a
   recommendation (never execute it).
4. High `avg_fetchTime` alongside low `avg_indexScanTime` suggests
   non-covering indexes -- confirm with `capella_get_non_covering_index_queries`
   when it is in your current tool set; otherwise recommend that sweep as a
   follow-up instead of calling it.

## Numbers discipline
Every number cited about one query (count, avg, sum) MUST come from the SAME
result row of the SAME tool. Never merge rows from different tools into one
claim, even when the statements look identical.
