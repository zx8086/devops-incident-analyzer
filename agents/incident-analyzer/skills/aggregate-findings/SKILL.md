# Skill: Aggregate Findings

## Purpose
Correlate findings from multiple datasource sub-agents into a unified
incident report with cross-datasource timeline and causal analysis.

## Procedure
1. Collect DataSourceResults from all sub-agents that responded
2. Align findings on a shared timeline (normalize all timestamps to UTC)
3. Identify causal chains: which event preceded which across datasources
4. Detect correlation patterns:
   - Log error spike (Elastic) + consumer lag spike (Kafka) = upstream failure
   - Slow queries (Couchbase) + API latency (Konnect) = database bottleneck
   - Gateway errors (Konnect) + no backend errors = gateway misconfiguration
5. Calculate a confidence score (0.0-1.0) based on data completeness
6. Identify gaps: datasources that returned no data or errors

## Output Format
```
| Time (UTC) | Datasource | Finding | Severity |
|------------|-----------|---------|----------|
| 2024-01-15T14:30:00Z | Elastic | Error rate spike in payment-service | High |
| 2024-01-15T14:30:15Z | Kafka | Consumer lag 50k on payments topic | High |
| 2024-01-15T14:29:45Z | Couchbase | Fatal N1QL query in orders bucket | Critical |

Correlation: Database fatal query at 14:29:45 preceded log errors at 14:30:00
and Kafka backpressure at 14:30:15. Root cause likely database-related.

Confidence: 0.85
Gaps: Konnect agent did not return data (API gateway not in incident path)
```

## Edge Cases
- Single datasource responded: present findings without correlation, lower confidence
- Conflicting timelines: present both with a note about the discrepancy
- No findings from any datasource: report explicitly with 0.0 confidence
