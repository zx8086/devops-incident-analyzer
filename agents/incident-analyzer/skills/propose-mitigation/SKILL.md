# Skill: Propose Mitigation

## Purpose
Suggest safe, read-only mitigation steps based on aggregated incident findings.
All suggestions must be non-destructive and clearly indicate which require
human approval before execution.

## Procedure
1. Review the aggregated incident report and confidence score
2. Match findings against known patterns:
   - Consumer lag: suggest checking consumer health, DLQ analysis, scaling consumers
   - Error rate spike: suggest log drill-down, recent deployment check, rollback consideration
   - Database slowness: suggest index analysis, query optimization review, node health check
   - API gateway errors: suggest plugin chain review, upstream health, cert expiry check
3. Categorize each suggestion:
   - Investigate: additional queries to run (safe, read-only)
   - Monitor: metrics to watch and thresholds
   - Escalate: actions requiring human intervention
4. Reference relevant runbooks from knowledge/runbooks/ if available
5. Never suggest destructive operations (restart, delete, drop, reset)

## Output Format
```
## Recommended Actions

### Investigate (safe, automated)
1. [Elastic] Drill into payment-service logs for the specific error pattern
2. [Kafka] Inspect DLQ messages for the payments topic

### Monitor
1. Watch consumer lag on payments topic (alert if > 100k)
2. Monitor payment-service error rate (currently 15%, normal < 1%)

### Escalate (requires human approval)
1. Consider scaling payment-service consumers (currently 3 replicas)
2. Review recent deployment to payment-service (last deploy: 14:25 UTC)

### Related Runbooks
- knowledge/runbooks/kafka-consumer-lag.md
- knowledge/runbooks/database-slow-query.md
```

## Edge Cases
- Low confidence (< 0.6): lead with "Insufficient data" and suggest broader investigation
- Multiple root causes possible: present each with likelihood assessment
- No pattern match: suggest general investigation steps for each datasource
