---
name: hot-node-low-watermark-relief-and-single-shard-reshard
description: Resolve a single hot-node low-watermark forecast caused by an oversized single-shard index — interim allocation-filter reroute, then reshard for the durable fix.
inputs:
  cluster: { type: string, required: true }
  pressured_index: { type: string, required: false }
outputs:
  status: { type: string }
---

# Hot-node low-watermark relief and single-shard reshard

Source: `Elastic_Optimisation_Playbook_v12.docx` §6.8.

## Why / Pattern

AutoOps low-watermark forecasts sometimes fire on a single hot node while the tier as a whole has headroom. Confirm whether the problem is tier capacity or per-node imbalance before acting — Elastic Cloud tier autoscaling responds only to tier-level capacity and will not rebalance individual nodes.

Diagnose with `GET _cat/allocation?v` and the node FS stats. If one node sits far below its siblings, look for an oversized single-shard index: a single primary above ~50 GB forces its primary and replica onto two nodes only, starving the third in a three-zone tier.

## Interim relief — allocation-filter reroute (§6.8.1)

Move specific shards off the pressured node onto the under-used one, then remove the filter so nothing stays pinned:

```
PUT <index>/_settings
{ "index.routing.allocation.exclude._name": "instance-XXXX" }

# wait for relocation:
GET _cluster/health   # until relocating_shards = 0

PUT <index>/_settings
{ "index.routing.allocation.exclude._name": null }
```

Rules:

- Pick shards whose other copy is not already on the target node to avoid primary/replica co-location.
- Safe on a GREEN cluster; relocations are recovery-throttled (~40 MB/s), so a ~10 GB shard takes a few minutes.
- Removing the filter does not bounce the shard back — the allocator will not move it into the fuller node.

## Durable fix — reshard the oversized index (§6.8.2)

For a content index that only grows (no ILM roll-off), reindex it into multiple primary shards so it distributes across all nodes and each shard stays under ~50 GB. Use an alias so future reshards need no consumer changes.

us-cld worked example (2026-05-24): `mulesoft-aggregations-prod-v6`, ~168M docs / 103 GB in one shard, planned to 3 primaries — see `us-cld_mulesoft_aggregations_reindex_plan_v1`.

## Check the source Transform state before reshard (§6.8.3)

A pre-created destination index that has sat empty for weeks is a strong signal the migration was paused. Before reindexing, find the Transform (or other writer) that targets the source index and confirm its current state and last successful checkpoint.

Search `.transform-internal-*` for docs whose `dest.index` matches the source. The latest `data_frame_transform_checkpoint-<id>-<N>` doc shows the last checkpoint number and its `timestamp_millis`. If that timestamp is stale, the Transform stopped writing then; the source index is effectively static.

Verify by counting source docs twice with a delay; if the count is stable, no live writes are happening.

A stopped Transform changes the reshard runbook. No write-pause or dual-write window is needed for the reindex; cutover becomes an admin step (update `dest.index` on the Transform and restart) or a retirement step (delete the Transform), to be agreed with the data owner.

us-cld worked example (2026-05-26): the Transform `mulesoft-aggregations-prod-v6` had last checkpoint 71299 at 2026-03-22 02:11 UTC, 65 days stale. v6 doc count was stable at 168,367,922 over two consecutive checks. The reshard reindex was started immediately without a write-pause window; the cutover or retirement decision is held with the Mulesoft team.

## Validation

- `_cat/allocation?v` shows the three hot nodes within 10% disk usage of each other.
- The reshard target alias serves reads with no consumer change.
- AutoOps low-watermark forecast clears within one observation window.

## Hand off

If the durable reshard ran via IaC, open MR via `open-mr` skill. Update `memory/runtime/context.md` with the source index, target shard count, and Transform-state finding. Stop.
