---
name: validate-cluster-state
description: Re-query Elastic Cloud and the cluster API for the live state of a deployment before any change. Returns a state snapshot the maker step uses, plus an explicit pass/fail against the IR-174 five-condition pre-change gate.
inputs:
  cluster: { type: string, required: true }
  change_type: { type: string, required: false }   # "resize" | "ilm" | "template" | "pipeline" | ... — drives which gate conditions apply
outputs:
  state: { type: object }
  gate_passed: { type: boolean }
  gate_failures: { type: array }
---

# Validate cluster state

Source of truth: `knowledge/reference/operating-guide.md` §3 durability layers, `knowledge/playbook/9-validation-checklists.md`, `knowledge/issues/cross-cluster.md` IR-174.

## What to fetch

1. `elasticsearch_cloud_get_deployment` → topology (hot/warm/cold/frozen/coord/ml sizes + max + zones).
2. `elasticsearch_cloud_get_plan_history` → last 5 plans. Reversals (downsize then upsize within 14 days) are noise — call them out so the maker step doesn't mistake noise for a baseline.
3. `elasticsearch_get_cluster_health` → status, unassigned shards, pending tasks.
4. `elasticsearch_get_nodes_stats` (jvm.heap, gc, breaker, thread_pool) → see gate conditions below.
5. `elasticsearch_ilm_get_lifecycle` → policy count + names. Spot-check the eight built-ins that auto-revert on upgrade (metrics, logs, synthetics, profiling, @lifecycle, ilm-history, watch-history) per §3.4.
6. `elasticsearch_list_transforms` + `elasticsearch_get_transform_stats` → flag any stopped > 30 days (see us-cld mulesoft-aggregations precedent).
7. For frozen tier capacity: **never** use `nodes_stats fs` (that's the LRU cache). The cache filling to 90%+ is expected and not a capacity signal. True capacity = Elastic Cloud console "Searchable object storage". Instruct the caller.

## The IR-174 pre-change gate (mandatory for `resize` and `ilm` change_types)

Cluster health alone is insufficient. eu-b2b passed health=green while the data_cold parent breaker had tripped 2,034 times on instance-0000000122; us-cld plan #229 was greenlit and still failed because per-zone disk-fit wasn't measured. All five must pass:

| Condition | Source data | Threshold |
|---|---|---|
| a) Cluster health | `cluster/health.status` | `green` |
| b) Breaker tripped count, affected tier | `nodes/stats.breaker.*.tripped` per node | `0`, or clearly trending toward 0 over last hour |
| c) Old-gen heap peak | `nodes/stats.jvm.mem.pools.old.peak_used / max` per node | `< 90%` |
| d) Thread-pool queue + rejected | `nodes/stats.thread_pool.{write,search,bulk}.{queue,rejected}` | within historical norms (no spikes vs last 24h baseline) |
| e) Per-zone disk-used + 20% buffer | `nodes/stats.fs` summed per zone | `< new per-zone disk capacity` (for resize change_type) |

Output `gate_passed: false` with `gate_failures: [list of failed condition letters]` if any fail. The maker step refuses to draft a diff while the gate is failing.

## Output shape

```yaml
cluster: eu-b2b
health: GREEN
topology:
  hot:    { size: 15, max: 60, zones: 3 }
  warm:   { size: 16, max: 60, zones: 3 }
  cold:   { size: 4,  max: 60, zones: 1, heap_pressure: ["0156=83%", "0141=74%+1oldGC"] }
  frozen: { size: 4,  max: 60, zones: 1, capacity: "check console" }
plan_history_last5: [...]
plan_reversals_14d: ["us-cld frozen 15→30 GB (2026-05-22) reverses 30→15 GB"]
ilm_policies: 47
builtin_policy_drift: []                  # any of the 8 that auto-revert
dormant_transforms: []
gate_passed: true
gate_failures: []
risks_to_surface_in_mr:
  - "cold tier heap > 80% on instance-0000000156 — flag if change adds cold load"
```

## Risks that always go into the MR `## Risks` section

- Health != GREEN
- Any node heap > 80% (warning) or > 90% (gate failure)
- Any old GC > 0 in last 24h
- Any breaker tripped count > 0 in last hour
- `.alerts` unmanaged (blocks hot downsize until fixed)
- Dormant transforms > 30 days
- Built-in policy drift (any of the 8 that auto-revert)
- Plan reversals within last 14 days for the affected tier
