---
name: dedicated-ilm-policy-for-high-retention-network-logs-streams
description: Dedicated ILM policy for high-retention network-logs streams
inputs:
  cluster: { type: string, required: true }
outputs:
  status: { type: string }
---

# Sub-procedure: Dedicated ILM policy for high-retention network-logs streams

> Source: Elastic_Optimisation_Playbook_v12 §3.10

--------------------------------------------------------------------------------

Symptom: a single high-volume, long-retention stream (network-logs from
Cisco Meraki / FTD on ap-cld) shares the observability-default policy
sized for short retention. Result: the stream either forces the shared
policy retention longer than observability wants, or is capped below its
compliance requirement.

Fix pattern: dedicated 5-phase policy that is sized for the stream's
ingest and retention profile.

    PUT _ilm/policy/ap-network-logs
    {
    "policy": {
    "phases": {
    "hot": { "actions": { "rollover": { "max_primary_shard_size":
    "10gb", "max_age": "1d" }, "set_priority": { "priority": 100
    } } },
    "warm": { "min_age": "3d", "actions": { "allocate": {
    "number_of_replicas": 1 }, "set_priority": { "priority": 50 } }
    },
    "cold": { "min_age": "7d", "actions": {
    "searchable_snapshot": { "snapshot_repository":
    "found-snapshots" }, "set_priority": { "priority": 0 } } },
    "frozen": { "min_age": "30d", "actions": {
    "searchable_snapshot": { "snapshot_repository":
    "found-snapshots" } } },
    "delete": { "min_age": "365d", "actions": { "delete": {} } }
    }
    }
    }

-   Key choices: 10GB rollover (not 25GB) because the stream is busy but
    not enormous, and smaller rollovers keep warm merges fast.

-   365-day delete reflects network-logs compliance retention --- do not
    blend into the 90-day observability bucket.

-   Attach via a dedicated index template at priority 200 so the
    observability-default index template (priority 100) does not win the
    pattern match.

-   Monitor hot-tier docs/s after attach --- dedicated policies isolate
    backpressure from the shared pool.
