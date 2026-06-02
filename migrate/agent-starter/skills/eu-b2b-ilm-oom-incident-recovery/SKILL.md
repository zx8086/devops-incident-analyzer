---
name: eu-b2b-ilm-oom-incident-recovery
description: Step-by-step recovery for cold-tier OOM caused by an ILM frozen min_age pull-in triggering force-merge stampede. Source incident eu-b2b 2026-05-15.
inputs:
  cluster: { type: string, required: true, default: eu-b2b }
outputs:
  status: { type: string }
---

# eu-b2b — Cold-Tier OOM Incident Runbook

**Date:** 2026-05-15
**Deployment:** eu-b2b (`02655c3733ea471999d9cec39a17df32` / cluster `71bdf337bb454d7ba192142d5a9925cf`)
**Companion:** `eu-b2b_ILM_Replica_and_Frozen_Change_Spec_2026-05-15.md`

## Situation

The 2026-05-15 ILM change (applied 11:09-11:14) pulled the frozen `min_age` from 14d to 7d. That made the backlog of cold indices aged 7-14d immediately eligible for frozen conversion, which runs `force_merge_index: true` — producing ~200 concurrent shard-level force-merges, ~100 on each of the two cold nodes. The cold tier is at the `aws.es.datacold.d3` minimum (2 nodes x 2 GB RAM / ~1 GB heap / **1 vCPU** each) and cannot absorb that burst. Result: cold nodes OOM-cycling; at one point both were down together, taking the cluster RED with 265 unassigned primary shards.

Last observed (~12:1x): cluster **yellow**, 8 data nodes up, 0 unassigned primaries — but flapping.

The replica part of the change is correct and validated. The frozen pull-in should have been staged *after* a cold-tier resize, not alongside it. The fix is to take load off the cold tier, then give it capacity — **in that order**.

## Execution order — do this now

### Step 1 — Assess current state

```
GET _cluster/health
```

Read: `status`, `unassigned_primary_shards`, `number_of_data_nodes` (expect 8; fewer = a cold node is down).
`unassigned_primary_shards: 0` = tolerable. `> 0` = data unavailable — still follow the same order below; the steps do not change.

### Step 2 — Cap the load: stop ILM **(do this first, before any resize)**

```
POST _ilm/stop
GET  _ilm/status        # confirm "operation_mode": "STOPPED"
```

This stops *new* phase transitions and force-merges being queued. It does not kill the ~200 already in flight — those continue and drain — but it stops the queue being continuously topped up, which is what keeps the cold nodes pinned. Fully reversible. Rollovers also pause; a short pause is harmless (write indices just grow slightly before they roll).

### Step 3 — Let the in-flight backlog drain and the cold tier stabilise

Monitor until the force-merge queue is near zero and the cold nodes are steady:

```
GET _cat/tasks?actions=indices:admin/forcemerge*&v        # expect count trending toward 0
GET _nodes/stats/jvm,os?filter_path=nodes.*.name,nodes.*.jvm.mem.heap_used_percent,nodes.*.os.cpu
```

The two cold nodes may still OOM-restart once or twice while the remaining backlog clears on 1 vCPU — expected, Cloud auto-restarts them, data is on persistent disk so nothing is lost. The risk to watch is **both** cold nodes down at once (RED). Proceed to Step 4 once: force-merge tasks near 0, cold-node heap stable (roughly < 70%), cluster yellow or green with 0 unassigned primaries.

> If both cold nodes stay down and the cluster is stuck RED, do not wait — go straight to Step 4. A grow plan proceeds on a red cluster (Elastic Cloud creates the new instances and migrates data; red does not hard-block a grow). The only hard plan blocker is a disk-full tier, which does not apply here.

### Step 4 — Resize the cold tier

Elastic Cloud console -> deployment **eu-b2b** -> **Edit** -> **Cold data** tier:

- **Size per zone: 2 GB -> 4 GB.** On `datacold.d3` this doubles heap (~1 GB -> ~2 GB) **and** CPU (1 -> 2 vCPU) per node.
- Max size (autoscaling) is already 4 GB — Current 4 GB = Max 4 GB is valid (Max >= Current), no Max change required. Optionally raise Max to 8 GB for future headroom (note: data-tier autoscaling is disk-driven, so it will not auto-react to memory pressure — the Current bump is the real fix).
- **Save** and confirm the plan. It rolls the two cold nodes one at a time (grow-and-shrink).

Verify after the plan completes:

```
GET _nodes/stats/jvm,os?filter_path=nodes.*.name,nodes.*.roles,nodes.*.jvm.mem.heap_max_in_bytes,nodes.*.os.available_processors
# cold nodes should show heap_max ~2 GB and available_processors 2
```

### Step 5 — Resume ILM

```
POST _ilm/start
GET  _ilm/status        # confirm "operation_mode": "RUNNING"
```

The resumed force-merge / frozen-conversion work now runs on the larger cold nodes, which can absorb it.

### Step 6 — Verify recovery

```
GET _cluster/health                    # target: green, unassigned_shards 0, unassigned_primary_shards 0
GET _ilm/explain?only_errors=true       # expect no indices in an ERROR step
GET _nodes/stats/jvm,os ...             # cold-node heap healthy under resumed load
```

## Do not

- **Do not resize before Step 2.** Resizing into an active OOM loop makes the plan execution longer and bumpier — stop the load first.
- **Do not revert the ILM policy change.** The warm/cold replica add is correct and validated; reverting it re-opens the single-copy availability gap. Only the *sequencing* of the frozen pull-in was wrong, not the policy.
- **Do not delete or force-allocate cold shards.** The cold nodes' data is on persistent disk; OOM-restarts recover it automatically once the nodes are stable.

## Follow-up (after the incident is closed — not part of this runbook)

Structural fix so the next optimisation change does not hit the same ceiling: with frozen now at 7d, the cold phase is only a 2-day window (5d-7d). Dropping the cold phase entirely (warm 5d with replica -> frozen 7d) takes the cold tier out of the force-merge hot path and lets it be downsized or removed. Spec this as a separate Terraform change.

## Operating note

Optimisation changes on these clusters surface secondary issues like this — expected, part of the process. The response is to flag the risk, monitor, and apply a mitigation or structural fix in the right order — not to halt the initiative. Note that `unassigned_primary_shards` returned to 0 each time: the change is working through turbulence, not failing.
