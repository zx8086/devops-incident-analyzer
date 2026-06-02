---
name: warmcold-tier-replica-policy
description: Raise warm-phase replicas from 0 to 1 on core ILM policies to remove single-copy exposure for streams that must survive a node loss.
inputs:
  cluster: { type: string, required: true }
  policies: { type: array, required: true }
outputs:
  policies_updated: { type: array }
---

# Warm/cold-tier replica policy — single-copy exposure

Source: `Elastic_Optimisation_Playbook_v12.docx` §3.15.

## Why / Pattern

The core ILM policies (`logs`, `metrics`, `logs-apm.app_logs-default_policy`, `metrics-apm.app_metrics-default_policy`, `traces-apm.traces-default_policy`, and the per-signal `metrics-apm` aggregate policies) set `allocate.number_of_replicas: 0` in the warm phase (min_age 3d; 4d for `transaction_1m`).

A backing index therefore runs a single copy from roughly 3 to 14 days of age — through the warm and cold phases — until it converts to an S3-backed frozen searchable snapshot. A warm or cold node restart or replacement orphans those replica-0 primaries and takes their indices RED until recovery. This was the 2026-05-15 eu-b2b incident: 96 unassigned primary shards across 167 data streams.

Hot-phase write indices are unaffected — they correctly carry 1 replica.

## Detect (§3.15.1)

Read each core policy and inspect the warm phase. Any policy with a warm-phase `allocate` action setting the replica count to 0 carries this exposure for every stream it manages.

```
GET _ilm/policy/logs,metrics,traces-apm.traces-default_policy
# inspect phases.warm.actions.allocate.number_of_replicas
```

## Fix (§3.15.2)

For streams that must stay searchable through a single node loss — APM traces and logs, Kong production logs, core metrics — raise the warm-phase replica count to 1 and leave cold and frozen at 0.

`PUT _ilm/policy` replaces the whole policy document, so:

1. GET the current policy first.
2. Change only `phases.warm.actions.allocate.number_of_replicas` to 1.
3. PUT the complete policy back.

The policy edit takes effect on the next phase transition; existing warm and cold backing indices already at 0 replicas need a one-off settings call to gain a copy immediately:

```
PUT .ds-logs-apm.app.*,.ds-traces-apm-*,.ds-logs-kong.*/_settings
{ "number_of_replicas": 1 }
```

Rules:

- Confirm the target tier has at least two data nodes and disk headroom before raising replicas — otherwise the new copies stay unassigned. On eu-b2b the warm tier has two nodes with ample free space.
- Leave cold and frozen at 0. Cold is read-only and lower-cost; frozen is an S3-backed searchable snapshot and recoverable. Confining the replica to the warm band keeps the extra storage cost small.
- APM-bundled policies (`logs-apm.app`, `metrics-apm.app`, `traces-apm.traces`) may auto-revert on Fleet package update — re-apply after stack upgrades, as in §3.9 and §8.2.

## Validation

Cross-ref §9.1 (After an ILM policy change):

- `_cluster/health` returns GREEN, 0 unassigned shards.
- `_cat/shards/.ds-logs-apm.app.*-*?h=index,shard,prirep,node` shows each warm backing index with both a primary and a replica.
- Warm-tier disk usage rises by the expected per-stream amount; if not, replicas failed to allocate (check tier headroom).

## Hand off

Open MR via `open-mr` skill to record warm-phase replica change in IaC. Update `memory/runtime/context.md` with policy list, affected stream patterns, and the one-off `_settings` call applied. Stop.
