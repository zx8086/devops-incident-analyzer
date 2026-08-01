---
name: incident-postmortem
description: Reconstruct a blameless incident postmortem from the aggregated findings -- timeline with explicit gap flagging, five-whys root-cause analysis, contributing factors, and action items with owners. Use once findings are aggregated and the incident is resolved or stable, to produce a structured retrospective a human can review and, via the "learn from TICKET-123" command, feed back into the agent's durable memory.
---

# Skill: Incident Postmortem

## Purpose
Turn a completed (or stabilized) investigation into a blameless postmortem
document: what happened, why, what made it worse than it needed to be, and
what concrete actions prevent recurrence. The postmortem is a proposal for
human review -- it is the raw material for the learning loop, not a verdict.

## When to Use
- The incident is resolved, or mitigated and stable, and findings have been
  aggregated with a confidence score.
- A significant near-miss occurred that would have been an incident if caught
  later.
- Not for minor anomalies, informational reports, or incidents with no
  learning value -- a postmortem nobody reads is noise.

## Principles
- Blameless: systems fail, not people. Write "the alert did not fire" or
  "the process lacked a rollback gate", never "X forgot to" or "Y should
  have known".
- Facts over speculation: every timeline entry and causal claim follows the
  cite-sources skill -- name the tool output that supports it. Anything not
  traceable to a tool output is labeled a hypothesis.
- Gaps are findings: an unexplained silence in the timeline is stated
  explicitly, not papered over.

## Procedure
1. Reconstruct the timeline from the aggregated findings: every event in UTC,
   each with its datasource and supporting tool output.
2. Flag timeline gaps (per the aggregate-findings skill): unexplained silence
   within a datasource, or an effect with no observed cause. Suggest where a
   human could look to close each gap.
3. Run a five-whys chain from the user-visible symptom down to the deepest
   cause the evidence supports. Stop at the last why the findings can ground;
   mark deeper whys as hypotheses rather than inventing certainty.
4. Separate the root cause from contributing factors: what made the incident
   possible versus what made it worse (missing alert coverage, stale runbook,
   slow escalation, absent rollback path).
5. Draft action items: each with a concrete owner role (team or function, not
   a person to blame), a priority, and a verifiable definition of done.
6. List related tickets and runbooks so the reader can traverse the evidence.

## Output Format
```
## Postmortem: <incident title>  (DRAFT for human review)
Severity: <critical|high|medium|low> | Duration: <detection -> resolution>
Confidence: <score from the aggregated report>

### Summary
<2-3 plain-language sentences: what broke, who was affected, how it ended>

### Impact
- <affected services / users / duration; quantify only from cited findings>

### Timeline (UTC)
| Time | Datasource | Event |
|------|------------|-------|
| 14:25 | GitLab | Deploy of payment-service v2.4.1 completed |
| 14:29 | Couchbase | Fatal N1QL query in orders bucket |
Gap: no Elastic events 14:31-14:44 despite active Kafka lag growth.

### Root Cause
<deepest evidence-grounded cause>

Five whys:
1. Why did checkout fail? -> ...
2. Why did the query stall? -> ...
(mark any un-evidenced why as HYPOTHESIS)

### Contributing Factors
- <what made it worse: detection, mitigation, or process shortfalls>

### Action Items
| Action | Owner | Priority |
|--------|-------|----------|
| Add alert on orders-bucket fatal queries | platform team | high |

### Related
- Tickets: <Jira keys from atlassian findings, e.g. OPS-123>
- Runbooks: knowledge/runbooks/<relevant>.md
```

## Sourcing
- Primary input is the pipeline's own aggregated report: findings, timeline,
  correlation notes, confidence score, and gap list.
- Atlassian findings (linked incidents, incident history, ticket comments)
  supply the human-action side of the timeline: when the ticket was opened,
  who was paged, what was tried.
- Close the loop: once a human has reviewed the postmortem and the ticket is
  final, the "learn from TICKET-123" command distills it into durable memory
  and, where approved, promoted skills. Mention this in the closing line of
  the postmortem so the operator knows the next step.

## Edge Cases
- Incident not yet resolved: produce a preliminary postmortem, mark it as
  such, and leave action-item owners as TBD.
- Single datasource responded: write the narrower postmortem, state that
  correlation was not possible, and carry the reduced confidence forward.
- Never file, update, or transition tickets from this skill: it proposes a
  document. Ticket writes happen only through the existing human-approved
  paths.
