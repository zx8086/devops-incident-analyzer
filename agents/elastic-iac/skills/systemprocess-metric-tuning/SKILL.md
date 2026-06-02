---
name: systemprocess-metric-tuning
description: Cut system.process docs/day 30x+ via interval bump and drop-processor filters in the Fleet integration policy.
inputs:
  cluster: { type: string, required: true }
  policy_name: { type: string, required: true }
outputs:
  estimated_docs_saved: { type: string }
---

# system.process metric tuning

Source: `Elastic_Optimisation_Playbook_v12.docx` §4.4.

## Why / Pattern

Symptom: `system.process` is emitting 10–15M docs/day across several Fleet policies despite most of those docs being idle processes (loopback listeners, kernel threads, always-zero-CPU consumers). Pattern confirmed on eu-cld Fleet policies contributing ~11–12M docs/day.

## Interval bump (§4.4.1)

- Raise `system.process` period from default `10s` → `300s` for host-observability policies (not application-metrics policies where short-interval process signal matters).
- Net effect: 30× reduction in docs/host-hour with no loss of visibility for 5-minute-granularity dashboards.

## Drop processor filter (§4.4.2)

In Fleet → integration policy → Advanced → processors, add:

```yaml
- drop_event:
    when:
      or:
        - equals: { process.name: "System Idle Process" }
        - equals: { process.name: "svchost.exe" }
        - regexp: { process.name: "^(kworker|ksoftirqd|migration|rcu_).*" }
        - range:  { system.process.cpu.total.pct: { lt: 0.001 } }   # near-zero-CPU processes
        - equals: { process.args: "" }                              # kernel threads
```

Rules:

- The `range` filter on `cpu.total.pct < 0.001` removes the idle-process floor that drives most volume.
- Test on a single host first (tag-scoped) — bad filters can silence every process except PID 1.
- Dashboards that depend on a full process inventory must be updated to query a longer time window or re-enable the integration on a small dedicated policy.

## Validation

Cross-ref §9.2 (After a Fleet agent policy change):

- Pilot tag group: observe ingest rate drop in Stack Monitoring for 60 min before broad rollout.
- `_cat/count/.ds-metrics-system.process-*` over 24h should show docs/day drop consistent with the 30× target (interval bump alone) and further with the drop filter.
- No alerting gap opened: check process-based watchers and SLOs for false negatives.

## Hand off

Open MR via `open-mr` skill to record the Fleet policy change in IaC if managed there. Update `memory/runtime/context.md` with policy name, pilot tag group, and before/after ingest numbers. Stop.
