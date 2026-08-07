---
name: propose-mitigation
description: Suggest safe, read-only mitigation steps -- investigate, monitor, and escalate actions, plus a stakeholder status-update template -- based on the aggregated incident findings and confidence score. Use after aggregation and confidence checks, to turn findings into recommended next actions without ever proposing a destructive operation.
---

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
4. Whenever any Escalate item is produced, draft a status update using the
   template in the output format below; fill every field from the aggregated
   report and never leave an unresolved placeholder in what gets posted. The
   Owner field requires a named human or on-call role -- when none is assigned
   yet, the first Escalate item IS the assignment request, and the draft stays
   a draft until a human takes ownership
5. Reference relevant runbooks from knowledge/runbooks/ if available
6. Never suggest destructive operations (restart, delete, drop, reset)

## Output Format
```markdown
## Recommended Actions

### Investigate (safe, automated)
1. [Elastic] Drill into payment-service logs for the specific error pattern
2. [Kafka] Inspect DLQ messages for the payments topic

### Monitor
1. Watch consumer lag on payments topic (alert if > 100k)
2. Monitor payment-service error rate (currently 15%, normal < 1%)

### Escalate (requires human approval)
1. Assign an incident owner for payment-service (no owner on record yet)
2. Consider scaling payment-service consumers (currently 3 replicas)
3. Review recent deployment to payment-service (last deploy: 14:25 UTC)

### Status Update (draft; post only once the Owner field names a human)
[HIGH] payment-service - error rate 15x above baseline, checkout degraded
Impact: ~30% of checkout requests failing since 14:25 UTC
Current state: investigating
Next update: in 30 minutes or on material change
Owner: payments on-call (per escalation item 1; do not post while unassigned)

### Related Runbooks
- knowledge/runbooks/kafka/kafka-consumer-lag.md
- knowledge/runbooks/couchbase/database-slow-queries.md
```

## Edge Cases
- Low confidence (< 0.6): lead with "Insufficient data" and suggest broader investigation
- Multiple root causes possible: present each with likelihood assessment
- No pattern match: suggest general investigation steps for each datasource
