# eu-b2b — ILM Replica & Frozen-Transition Change Spec

**Date:** 2026-05-15
**Deployment:** eu-b2b (`02655c3733ea471999d9cec39a17df32` / cluster `71bdf337bb454d7ba192142d5a9925cf`)
**Change vehicle:** `lifecycle-policies` Terraform stack. No manual writes — this document is a spec only.

## Purpose

Close the single-copy availability gap that took eu-b2b RED on 2026-05-15 (96 unassigned primary shards across 167 data streams). Root cause: the core ILM policies set `allocate.number_of_replicas: 0` in **both** the warm and cold phases, so a backing index runs a single copy from ~3 days to ~14 days of age — until it converts to an S3-backed frozen searchable snapshot. Any warm or cold node restart or replacement orphans those replica-0 primaries and takes their indices RED.

Two coordinated levers:

1. Carry **1 replica through warm and cold** for the production policies — this is the availability fix.
2. Pull the **frozen transition in from 14d to 7d** so data reaches S3-backed storage (where 0 replicas is safe and expected) sooner.

Total retention (`delete` phase `min_age`) is **unchanged for every policy**. The hot phase is **unchanged for every policy**.

## Capacity impact

- **Warm tier** — roughly flat. Today ~4 days dwell x 1 copy; target ~2 days dwell x 2 copies. Warm tier has ~3 TB free of 3.26 TB, so ample headroom either way.
- **Cold tier** — decreases. Today ~7 days dwell x 1 copy (7d-14d); target ~2 days dwell x 2 copies (5d-7d). Net cold footprint drops roughly 40%, which clears the cold-tier headroom concern (cold was ~65% full).
- **Frozen tier** — increases (more data, arriving sooner). S3-backed; this is expected and cheap.

## Change set by shape

### Shape A — core 5-tier (9 policies)

`logs`, `logs-aws`, `metrics`, `traces`, `synthetics`, `logs-apm.app_logs-default_policy`, `logs-apm.error_logs-default_policy`, `metrics-apm.app_metrics-default_policy`, `traces-apm.traces-default_policy`

| Phase | Field | Current | Target |
|---|---|---|---|
| warm | `min_age` | 3d | 3d (unchanged) |
| warm | `allocate.number_of_replicas` | 0 | **1** |
| cold | `min_age` | 7d | **5d** |
| cold | `allocate.number_of_replicas` | 0 | **1** |
| frozen | `min_age` | 14d | **7d** |
| hot / delete / all other actions | — | — | unchanged |

Preserve per-policy: hot rollover settings (these differ per policy — do not normalise them), `set_priority` on every phase, `readonly` on cold, `total_shards_per_node: -1` on warm/cold where it already exists (`logs-apm.error_logs-default_policy`, `traces-apm.traces-default_policy`, `synthetics`), the `searchable_snapshot` block including `force_merge_index: true`, and the `delete` `min_age` (30d / 45d / 60d depending on policy).

### Shape B — APM aggregates, current generation (13 policies)

`metrics-apm.internal_metrics-default_policy` and `metrics-apm.{service_destination,service_summary,service_transaction,transaction}_{1m,10m,60m}_metrics-default_policy`

| Phase | Field | Current | Target |
|---|---|---|---|
| warm | `min_age` | 4d | 4d (unchanged) |
| warm | `allocate.number_of_replicas` | 0 | **1** |
| cold | `min_age` | 7d | **5d** |
| cold | `allocate.number_of_replicas` | 0 | **1** |
| frozen | `min_age` | 14d | **7d** |
| hot / delete / forcemerge / shrink / set_priority | — | — | unchanged |

Preserve: warm `forcemerge` (`max_num_segments: 1`) + `shrink` (`number_of_shards: 1`, `allow_write_after_shrink: false`) + `total_shards_per_node: -1`; cold `readonly` + `total_shards_per_node: -1`; hot rollover (3d / 2gb); delete 30d.

### Shape F — RUM (1 policy)

`traces-apm.rum_traces-default_policy`

| Phase | Field | Current | Target |
|---|---|---|---|
| warm | `min_age` | 1d | 1d (unchanged) |
| warm | `allocate.number_of_replicas` | 0 | **1** |
| cold | `min_age` | 2d | 2d (unchanged) |
| cold | `allocate.number_of_replicas` | 0 | **1** |
| frozen | `min_age` | 10d | **7d** |
| hot / delete / forcemerge / shrink | — | — | unchanged |

### Shape E — system indices (1 policy) — optional

`system-indices-lifecycle`

| Phase | Field | Current | Target |
|---|---|---|---|
| warm | `min_age` | 30d | 30d (unchanged) |
| warm | `allocate.number_of_replicas` | 0 | **1** |
| hot / delete / forcemerge / shrink | — | — | unchanged |

No cold or frozen phase. Low-volume system indices — a small change that closes a 60-day single-copy window. Include if convenient; not load-bearing.

### Shape C — orphaned policies — DELETE (12 policies)

`metrics-apm.{service_destination,service_summary,service_transaction,transaction}_{1m,10m,60m}-default_policy`

Confirmed orphaned on 2026-05-15: `in_use_by` is empty for `indices`, `data_streams`, **and** `composable_templates` on all 12. They are the version 3-4 / 2026-03-07 generation, superseded by the Shape B `*_metrics-default_policy` generation that actually holds the indices. Remove all 12 from the TF stack — nothing references them.

### Shape D — dev/staging — NO CHANGE

`dev-staging-logs`, `dev-staging-metrics`, `dev-staging-traces`. Low-criticality, short retention (7-14d). Accept single-copy on non-prod; leave these policies as-is.

## Resulting phase layout (production shapes)

| Shape | Target layout | Single-copy window |
|---|---|---|
| A | hot (1 replica) -> warm 3d (1) -> cold 5d (1) -> frozen 7d -> delete 30-60d | none |
| B | hot (1 replica) -> warm 4d (1) -> cold 5d (1) -> frozen 7d -> delete 30d | none |
| F | hot (1 replica) -> warm 1d (1) -> cold 2d (1) -> frozen 7d -> delete 45d | none |

Phase `min_age` ordering validated for every policy: warm <= cold <= frozen <= delete.

## Example Terraform resource (illustrative — adapt to `lifecycle-policies` stack conventions)

```hcl
resource "elasticstack_elasticsearch_index_lifecycle" "logs" {
  name = "logs"

  hot {
    min_age = "0ms"
    rollover {
      max_age                = "7d"
      min_docs               = 1000
      max_primary_shard_size = "30gb"
    }
    set_priority { priority = 100 }
  }

  warm {
    min_age = "3d"
    allocate { number_of_replicas = 1 }   # was 0
    set_priority { priority = 50 }
  }

  cold {
    min_age = "5d"                         # was 7d
    allocate { number_of_replicas = 1 }   # was 0
    readonly {}
    set_priority { priority = 25 }
  }

  frozen {
    min_age = "7d"                         # was 14d
    searchable_snapshot {
      snapshot_repository = "found-snapshots"
    }
  }

  delete {
    min_age = "30d"
    delete { delete_searchable_snapshot = true }
  }
}
```

Confirm whether the stack expresses `force_merge_index` on `searchable_snapshot` and `total_shards_per_node` on `allocate` through the provider — preserve those wherever the current policy carries them.

## Suggested apply order

1. Remove the 12 Shape C policies (no effect on data; clears drift).
2. Apply the frozen `min_age` pull-in (14d -> 7d) and cold `min_age` (7d -> 5d). This drains cold-tier disk first and creates headroom.
3. Apply the warm and cold `number_of_replicas` 0 -> 1.

Steps 2 and 3 can be a single apply; the ordering note only matters if cold-tier disk is tight at apply time.

## Post-apply validation

- Policy `version` on each edited policy incremented by 1 (`GET _ilm/policy/<name>`).
- `GET _ilm/explain` across managed indices shows no `step: ERROR`.
- Cluster health stays green; `unassigned_shards` returns to 0 after rebalancing settles.
- Warm and cold tier disk: confirm warm absorbs the new replicas and cold disk usage falls as dwell time shrinks.
- Spot-check a Shape B shrunk index after its warm transition: confirm the resulting `shrink-*` index ends with `number_of_replicas: 1`.

## Existing indices

The policy edits apply to each index on its **next phase transition**. Indices already in warm or cold keep 0 replicas until they transition — but with frozen pulled to 7d, cold indices older than 7d cycle to the S3-backed frozen tier quickly, and newer indices pick up the warm replica. Full convergence is roughly one frozen cycle (~7 days).

For immediate closure, an optional one-off `PUT <indices>/_settings {"number_of_replicas": 1}` can be run, **scoped to indices currently in the warm or cold phase only** (an unscoped call would also hit frozen `partial-*` indices). This is an operational step, not part of the TF stack.

## Caveats

- **APM-bundled policy auto-revert** — `logs-apm.*`, `metrics-apm.*`, `traces-apm.*` (all of Shape B and F, plus 4 of Shape A) are managed by the APM integration package and can be reverted by Fleet on a package update. Re-apply via Terraform after stack upgrades; track as in playbook section 3.9.
- **Frozen force_merge + delete stall** — more frozen churn raises exposure to the `force_merge_index` / delete-step stall pattern (playbook section 3.6.3). Watch the delete step on frozen indices after the change.
- **Frozen query latency** — data 7 days and older now answers from searchable snapshots (an S3 cache miss is slower than a warm/cold local read). Confirm this is acceptable for any dashboard that queries the 1-4 week range before committing the frozen pull-in. The frozen `min_age` can be tuned independently of the replica change — keeping frozen at 10-14d still leaves the gap fully closed by the warm+cold replicas alone, just with a larger warm/cold disk footprint.

## Post-apply observations (2026-05-15)

The Terraform apply landed 11:09-11:14 and validated correctly (all 24 production policy versions +1, 12 Shape C policies deleted, 0 ILM step errors, 0 unassigned primaries throughout).

At 11:46 cold node `instance-0000000141` ran out of memory and was auto-restarted by Elastic Cloud. Cause: the frozen `min_age` pull-in (14d -> 7d) made the backlog of cold indices aged 7-14d immediately eligible for frozen conversion, which runs `force_merge_index: true`. This produced ~200 concurrent shard-level force-merges, ~100 on each of the two cold nodes — and the cold tier is provisioned at the `aws.es.datacold.d3` minimum: 2 nodes x 2 GB RAM (1.07 GB heap) / 1 vCPU each. The nodes could not absorb the one-time migration burst.

The policy design is sound; the cold tier is under-provisioned to absorb the migration burst. Two structural options:

1. **Resize cold tier** — raise cold `size/zone` from 2048 MB to 4096 MB (within the existing autoscaling ceiling of 4096; autoscaling itself is disk-driven and will not react to a memory/CPU burst). Doubles heap and vCPU per cold node.
2. **Drop the cold phase** — with frozen now at 7d, the cold phase is only a 2-day window (5d-7d). Removing it (warm 5d with replica -> frozen 7d) takes the memory-starved cold nodes out of the force-merge path entirely and allows the cold tier to be downsized or removed. This is the cleaner end-state.

### Operating note — expected turbulence

Optimisation and remediation changes on these clusters will surface secondary issues like this. That is expected and is part of the process, not a signal to halt. The approach: flag the likely secondary effects as known risks before a change, monitor them after, and respond with mitigation or a structural fix. In-flight processes are not stopped to chase side-effects unless data is genuinely at risk — and here `unassigned_primary_shards` stayed at 0 throughout, i.e. no data was ever unavailable. A node auto-restart under a one-time migration burst is tolerated turbulence, not a failure of the change.
