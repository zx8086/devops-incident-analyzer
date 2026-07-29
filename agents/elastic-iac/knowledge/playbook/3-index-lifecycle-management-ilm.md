---
type: Playbook Section
title: "3. Index lifecycle management (ILM)"
description: "Operational playbook chapter 3: index lifecycle management (ilm)."
status: stable
tags: [playbook, operations]
generated:
  by: human:simon
  at: 2026-07-29
---
# 3. Index lifecycle management (ILM)

Source: Elastic_Optimisation_Playbook_v12 §3 (reference content).

## §3.1 The classic 4-phase pattern

-------------------------------

Use when a stream writes \>10 GB/day per shard and has a clear warm
window where query load drops. This is the default for eu-cld logs and
us-cld logs.

    {
      "name": "logs-classic-4phase",
      "hot": { "priority": 100, "max_age": "1d", "max_primary_shard_size": "25gb", "rollover": true },
      "warm": {
        "min_age": "3d",
        "priority": 50,
        "allocate": { "number_of_replicas": 1 },
        "forcemerge": { "max_num_segments": 1 },
        "shrink": { "number_of_shards": 1, "allow_write_after_shrink": false }
      },
      "cold": { "min_age": "10d", "priority": 0, "allocate": { "number_of_replicas": 0 } },
      "frozen": { "min_age": "30d", "searchable_snapshot": { "snapshot_repository": "found-snapshots", "force_merge_index": false } },
      "delete": { "min_age": "90d", "delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } }
    }

-   Rollover threshold: default to 25 GB primary shard size. Document
    any deviation in the policy description; hand-rolled 2 GB and 75 GB
    policies have caught us out.

-   Replicas in warm: drop from 2 → 1 at warm entry on high-volume
    streams. Saves disk; warm data is re-buildable from snapshot.

## §3.2 Warm-phase forcemerge and shrink --- when NOT to use

--------------------------------------------------------

Forcemerge and shrink are expensive. On low-volume streams they actively
hurt us:

-   Forcemerge blocks rollovers on the source index until it finishes
    (sometimes hours).

-   Shrink requires all shards to be on one node, which fights the
    allocator.

-   On shards \<2 GB, forcemerge saves almost no disk --- segment count
    is already low.

*Rule of thumb: if primary shard size at warm entry is under 5 GB, skip
forcemerge. If under 10 GB and you do not shrink, skip shrink. Use Path
B (§3.6).*

## §3.3 Cold-tier migration

-----------------------

Cold-tier data lives in searchable snapshots, not on-cluster. Moving a
large data stream to cold the first time can saturate the snapshot
repository and push cold-node disk to 90%+.

## §3.3.1 Pre-flight checklist

-   Confirm snapshot repository is healthy: GET
    _snapshot/found-snapshots/_status.

-   Check cold-tier disk headroom: target \<70% used before a migration;
    80% triggers watermark and blocks writes.

-   If autoscaling is on, verify the ceiling is above current usage +
    expected migration: GET _autoscaling/capacity.

-   Stagger large migrations --- do not flip cold min_age on \>2
    policies in the same day.

## §3.3.2 Frozen min\_age tuning to relieve cold-tier pressure

Pattern used on eu-cld 21 April: cold tier hit 87--91% across 3 nodes.
Rather than raise the autoscaling ceiling alone, frozen min_age was
lowered on the top 6 retention policies from 30d → 14d. This shifts the
oldest 30--50 % of cold data into frozen (partial cache) --- near-zero
user impact for archival series, large headroom gain.

    {
      "name": "logs-classic-4phase",
      "hot": { "...": "unchanged" },
      "warm": { "...": "unchanged" },
      "cold": { "...": "unchanged" },
      "frozen": { "min_age": "14d", "searchable_snapshot": { "snapshot_repository": "found-snapshots", "force_merge_index": false } },
      "delete": { "min_age": "90d", "delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } }
    }

-   Only apply to policies where queries on data \>14d are rare ---
    check search activity before toggling.

-   ILM age counter is based on rollover date, not current time ---
    changes take effect as each index progresses, not immediately.

## §3.4 Policy migration drift --- the checklist

--------------------------------------------

Three different clusters have drifted off their declared policies
through silent upgrades and package updates. Run this checklist monthly
and always after an Elastic upgrade:

-   Export all custom policies: GET _ilm/policy → diff against
    git-stored baselines.

-   List indices on built-in policies that should be on custom ones: GET
    _cat/indices?h=index,ilm.policy&v.

-   Specifically check the seven defaults that auto-revert on upgrade:
    metrics, logs, synthetics, profiling, \@lifecycle, ilm-history,
    watch-history.

-   For APM: verify traces-apm, metrics-apm, logs-apm are on the custom
    policy, not the Fleet-bundled one (see §8.2).

-   Check for indices matching enrich patterns that are not actually in
    _enrich/policy --- those are orphans (see §6.3).

## §3.5 ILM anti-patterns seen in production

----------------------------------------

  **Anti-pattern**                                                **Impact**                                                         **Fix**
  --------------------------------------------------------------- ------------------------------------------------------------------ --------------------------------------------------------------------
  2 GB rollover threshold on high-volume stream                   786 indices, 5 rollovers/day, metadata churn on eu-cld             Raise to 10--25 GB; consolidate existing
  Forcemerge on \<2 GB shards B                                   locks rollover chain for hours, no disk saving R                   emove forcemerge from warm, use Path B
  Multiple small policies with identical phases                   Drift across copies; one gets upgraded, others don't C             ollapse to single shared policy, alias via index template
  \@lifecycle built-in on production data R                       everts silently on upgrade; hot-only by default A                  lways use custom-named policies; never rely on built-ins
  Policy with no delete phase                                     Indices accumulate forever; cold tier creep                        Every policy must have explicit delete phase
  Dedicated high-retention streams on shared 10GB/30-day policy   Network-logs swamping observability retention; indexing pressure   Split to dedicated policy sized for stream characteristics (§3.10)

## §3.6 Path B --- consolidated pattern for low-volume streams

----------------------------------------------------------

When to use: primary shard size at warm entry is \<5 GB, stream has no
concurrent heavy search load, or the estate has \>20 similar policies to
unify.

Principle: warm phase does allocation + priority only; all
merge/consolidation work happens at the frozen transition via
force_merge_index:true on the searchable_snapshot action. This is
cheaper because snapshot-time merge is done once, on already-mostly-cold
data, instead of fighting warm-phase writes.

    {
      "name": "pathb-uniform-4tier",
      "hot": { "priority": 100, "max_age": "1d", "max_primary_shard_size": "10gb", "rollover": true },
      "warm": { "min_age": "3d", "priority": 50, "allocate": { "number_of_replicas": 1 } },
      "cold": { "min_age": "7d", "priority": 0, "allocate": { "number_of_replicas": 0 } },
      "frozen": { "min_age": "14d", "searchable_snapshot": { "snapshot_repository": "found-snapshots", "force_merge_index": true } },
      "delete": { "min_age": "90d", "delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } }
    }

## §3.6.1 Path B rollout on eu-b2b

-   13 policies across EDI, Boomi, and APM streams migrated to this
    shape over Apr 13--21.

-   Result: 113 shards eliminated (2,956 → 2,843), 97 GB hot-tier disk
    freed, 19 deprecated streams deleted.

-   Cost delta: net +€160--270/month (cheaper warm, marginally more
    frozen) offset against ops time saved from fewer forcemerge-induced
    rollover jams. Break-even ≤3 months.

## §3.6.2 Path B implementation phases (reference for future clusters)

**Phase**               **Action**                                                                                 **Duration**
  ----------------------- ------------------------------------------------------------------------------------------ --------------
  0 --- Baseline          Inventory all policies, classify by shard size at warm entry, identify Path B candidates   1 day
  1 --- Template          Define pathb-uniform-4tier policy, test on single non-prod stream                          1 day
  2 --- Pilot             Migrate 3--5 low-volume streams, observe rollover and merge behaviour for 48h              3 days
  3 --- Fleet migration   Migrate remaining streams in batches of 3; attach policy, let ILM age them naturally       1--2 weeks
  4 --- Cleanup           Delete old policies, validate no orphan indices, document cost outcome                     1 day

## §3.6.3 Path B caveat --- frozen force\_merge\_index can block deletion

Observed during eu-b2b Path B rollout: a Path B policy defines
force_merge_index:true on the frozen searchable_snapshot action. When
the underlying index finally reaches delete min_age, ILM can stall at
'Waiting for force merge to complete' if the frozen tier is under
pressure or the snapshot repository is busy. Indices then accumulate in
frozen, not progressing to delete.

-   Detect: GET _ilm/explain/ shows step=forcemerge or phase=frozen
    past expected delete age.

-   Check snapshot repository load: GET
    _snapshot/found-snapshots/_status --- look for in_progress and
    task queue.

-   Mitigation: either move the stuck index manually via POST _ilm/move
    to delete phase once frozen has completed its merge, or defer
    force_merge_index by relying on the snapshot-time merge at
    cold→frozen transition only and removing it from the policy
    definition on streams where delete timing is strict.

-   Rule: for any policy with delete min_age within 30d of frozen
    min_age, consider whether force_merge_index is worth the risk of
    deletion-phase stalls.

## §3.7 Sub-procedure: Dead data stream cleanup

Symptom: a data stream has an empty write index rolling over every day.
Observed on eu-b2b (19 deprecated streams).

Cause: the application stopped writing but the data stream was never
deleted. ILM keeps rolling the empty write index because max_age fires.

## §3.7.1 Detect

GET

    _data_stream/*?filter_path=data_streams.name,data_streams.generation,data_streams.indices.index_name
    # Cross-reference against indices with 0 docs in last 7 days:
    GET

_cat/indices/.ds-*?h=index,docs.count,creation.date&s=creation.date&format=json

A high generation number combined with a write index of 0 docs is the
canonical fingerprint.

## §3.7.2 Remove

-   Confirm with stream owner the application is gone (check Fleet agent
    policies, CI job schedules, Boomi processes).

-   If managed by ILM, move the write index to a terminal step first so
    ILM does not fight the delete:

```{=html}
<!-- -->
```
    POST _ilm/move/.ds-<stream>-2026.04.21-000042
    { "current_step": { "phase": "hot", "action": "rollover",
    "name": "check-rollover-ready" },
    "next_step": { "phase": "delete", "action": "delete",
    "name": "delete" } }

-   Delete the data stream: DELETE _data_stream/<stream-name>.

-   Verify no matching index templates will re-create it on next ingest.
    Audit _index_template/* for any index_patterns that would match.

## §3.7.3 Validation

Re-run the detect query --- the stream should not reappear. Watch
_cat/indices for 24h: no new .ds-<stream>-* backing index should be
created. If one is, an upstream producer is still alive or a Fleet
integration is rehydrating it; abort and re-investigate before
re-deleting.

Cross-reference §9.1 (After an ILM policy change) for downstream
policy-level validation if the stream was tied to a custom policy.

## §3.8 Sub-procedure: Orphan index reattachment

Symptom: indices matching a known pattern have index.lifecycle.name
unset. Observed on eu-b2b (14 indices) and on eu-cld (storewatch-*,
which turned out to be enrich sources --- see §6.3 before reattaching).

Before reattaching anything, check §6.3 (Enrich policy source discovery
--- do not delete before checking). If the "orphan" is an enrich source
it is correctly unmanaged; reattaching it to an ILM policy with a delete
phase will destroy the enrich data.

## §3.8.1 Detect

GET _cat/indices/<pattern>*?h=index,ilm.policy&v
    # Filter rows where ilm.policy is blank or 'null'

For each candidate, confirm it is not an enrich source: GET
_enrich/policy and look for any indices entry referencing the index.

## §3.8.2 Reattach

PUT <index>/_settings
    { "index.lifecycle.name": "<target-policy>",
    "index.lifecycle.rollover_alias": "<alias>" // only for
    alias-based streams
    }

-   The ILM age counter resets to 0 at reattachment --- keep this in
    mind for delete timing on already-old data. If the index is already
    past its target retention, plan a manual delete instead of relying
    on ILM to catch up.

-   Always reattach to the same policy the new indices in that stream
    are using --- diverging policies cause split retention.

-   For data-stream backing indices, prefer fixing at the data-stream
    level so future backing indices inherit correctly.

-   Verify with GET /_ilm/explain --- expect policy field populated and
    phase=hot\|warm\|cold (not null). Re-check 24h later that the index
    is progressing through phases as expected. Cross-ref §9.1.

## §3.9 Sub-procedure: Built-in ILM policy revalidation after upgrade

Elastic ships seven built-in policies (metrics, logs, synthetics,
profiling, @lifecycle, ilm-history, watch-history). An upgrade or Fleet
package install silently re-applies the shipped definition, which is
hot-only with no delete phase. If these were customised, the
customisations are lost and data accumulates on hot.

Note (per §12.28): the 9.3 -> 9.4 upgrade did NOT auto-recreate built-in
ILM policies --- the assumption from earlier upgrades is now soft. Still
run this check after every upgrade.

## §3.9.1 Post-upgrade check

GET _ilm/policy/metrics
    GET _ilm/policy/logs
    GET _ilm/policy/synthetics
    GET _ilm/policy/profiling
    GET _ilm/policy/@lifecycle
    GET _ilm/policy/ilm-history
    GET _ilm/policy/watch-history

Compare phases against the git-stored baseline. Alert if phase count
differs from the baseline, or if phases.delete is missing on any policy
that previously had one.

## §3.9.2 Permanent fix

-   Never depend on built-in policies for production data. Copy to a
    custom name (e.g. logs-custom) and update index templates to
    reference the custom one.

-   Leave the built-ins as Elastic ships them so upgrades don't
    conflict.

-   Add a weekly scheduled check in the monitoring cluster: assert phase
    count and phases.delete.min_age on custom policies are unchanged
    since the last baseline commit. Fire on drift.

## §3.9.3 Validation

Cross-ref §9.1 (After an ILM policy change) and §3.4 (Policy migration
drift --- the checklist):

-   GET _ilm/explain/.ds-*?only_errors=true returns empty.

-   _cat/indices?h=index,ilm.policy shows production indices on the
    custom policy names, not the built-ins.

-   _index_template/* references custom policy names in
    template.settings.index.lifecycle.name.

If any policy drifted, restore from the git baseline via PUT
_ilm/policy/<name> with the saved JSON.

## §3.10 Sub-procedure: Dedicated ILM policy for high-retention network-logs streams

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

## §3.11 Aggressive rollover trigger profile (recommended default)

--------------------------------------------------------------

Today's lesson on eu-cld: the dominant ILM driver of shard sprawl is
daily rollover (max_age: 1d) on streams that produce far less than 10
GB per day. The aggressive profile slows rollovers without forcing
sparse streams to never roll.

    "hot": {
      "priority": 100,
      "max_age": "14d",
      "max_primary_shard_size": "50gb",
      "rollover": true
    }

-   Use 14d for prod policies (90d retention), 7d for nonprod (30d
    retention), 3d for very-short retention (≤14d).

-   Do NOT add min_primary_shard_docs or other min_* gate
    conditions --- see §3.12 for why.

-   Net effect on eu-cld (modelled): −51% shard count over 30--45 days.

## §3.12 Sub-procedure: ILM rollover guard semantics --- do not use min\_\* on shared policies

min_* rollover conditions (min_primary_shard_docs,
min_primary_shard_size, min_age, min_size, min_docs) are guards:
rollover triggers only when ALL min_* are met AND any max_* is met.
If a sparse stream never reaches the min_* threshold, the index never
rolls over --- regardless of max_age.

Concrete failure case (eu-cld, 5 May 2026): a kubernetes.state_cronjob
stream in eu_dtc_dev accumulated 7 docs across multiple days. With
min_primary_shard_docs: 1000000 set, the index would have stayed in
hot phase indefinitely, never moving to warm/cold/frozen, never reaching
the delete phase.

-   Symptom to watch for: GET _ilm/explain/\<index\> shows step:
    check-rollover-ready past the policy's max_age.

-   Verification: GET \<index\>/_ilm/explain and check the index has
    been hot longer than max_age while below the min_* threshold.

-   Rule: if the policy is shared across many streams of differing
    volume, do not use min_*. Rely on max_age +
    max_primary_shard_size only.

-   Acceptable use of min_*: dedicated single-stream policies where
    the stream's volume is bounded and known.

## §3.13 Sub-procedure: Empty retention-fleet templates inherit prod ILM

Templates at priority 250+ matching dev/stg/test/nonprod patterns can
match the patterns yet have template: {} (empty body). They win the
priority arbitration but do nothing --- dev/stg streams inherit whatever
the composed <type>@settings component specifies (typically the prod
policy). Result: dev/stg streams silently inherit the prod 90-day ILM.

Pattern observed on eu-cld; suspected on ap-cld and us-cld --- audit
each. Memory cross-ref: project_retention_fleet_templates_gotcha --- PVH
*-nonprod-retention-fleet templates (priority 251) may be empty.

## §3.13.1 Detect

GET _index_template/*nonprod-retention*

For each: inspect index_template.template. If empty {}, the template is
inert and its dev/stg index pattern is being routed to whatever default
ILM the components specify (usually the prod policy).

## §3.13.2 Fix

PUT each retention-fleet template with the correct nonprod ILM:

    PUT _index_template/logs-nonprod-retention-fleet
    {
      "index_patterns": ["logs-*-eu_*_stg", "logs-*-eu_*_dev", "logs-*-eu_*_test", "logs-*-eu_*_nonprod", "logs-*-eu_*_backend_test", "..."],
      "priority": 251,
      "composed_of": ["logs@mappings", "logs@settings", "logs@custom", "ecs@mappings", ".fleet_globals-1", ".fleet_agent_id_verification-1"],
      "template": {
        "settings": {
          "index": {
            "lifecycle": {
              "name": "eu-default-lifecycle-logs-nonprod"
            }
          }
        }
      },
      "data_stream": { "hidden": false, "allow_custom_routing": false }
    }

-   Effect applies on next rollover for matching backing indices.

-   Existing backing indices age out under their original (prod) policy
    until they roll over.

-   This pattern likely repeats across the federation --- audit ap-cld
    and us-cld for the same empty-body templates.

-   Adapt index_patterns to the patterns the empty template actually
    matched, and composed_of to the type prefix (logs@*, metrics@*,
    traces@*, synthetics@*).

-   No data loss; this is a retention drift correction for new indices
    only. If matching streams have max_age longer than the desired
    correction window, pair with a force-attach for existing backing
    indices.

## §3.13.3 Codify and validate

After the live PUT validates, codify the same templates in
stacks/<cluster>/templates.tf so they survive the next session and are
not re-overwritten by a Fleet package upgrade.

Post-change validation, after the next rollover on any matching stream:

-   GET <new-backing-index>/_settings.index.lifecycle.name reports the
    nonprod policy.

-   _ilm/explain on the new backing index shows the nonprod policy
    attached.

-   Ingest rate and Kibana dashboards remain unaffected.

## §3.14 Sub-procedure: Override index template pattern (priority 300)

When the goal is to add a setting (e.g. index.mode: logsdb,
index.mapping.source.mode: synthetic) without modifying a Fleet-managed
integration template, create a higher-priority override that composes in
the same components.

    PUT _index_template/logs-kubernetes.container_logs-logsdb
    {
      "index_patterns": ["logs-kubernetes.container_logs-*"],
      "priority": 300,
      "composed_of": [
        "logs@mappings",
        "logs@settings",
        "logs-kubernetes.container_logs@package",
        "logs@custom",
        "kubernetes@custom",
        "logs-kubernetes.container_logs@custom",
        "ecs@mappings",
        ".fleet_globals-1",
        ".fleet_agent_id_verification-1"
      ],
      "ignore_missing_component_templates": [
        "logs@custom",
        "kubernetes@custom",
        "logs-kubernetes.container_logs@custom"
      ],
      "template": {
        "settings": {
          "index": { "mode": "logsdb" }
        }
      },
      "data_stream": { "hidden": false, "allow_custom_routing": false }
    }

-   Priority 300 wins over the integration's priority-200 template.

-   composed_of mirrors the integration's composition, so package
    mappings/processors continue to apply.

-   ignore_missing_component_templates keeps the override resilient
    to optional \@custom hooks not yet defined.

-   Reversal: DELETE _index_template/\<override-name\>. The
    integration's template applies again on next rollover.

-   Use this whenever _component_template access is restricted
    (e.g. through limited tooling) and \@custom cannot be PUT directly.

## §3.15 Sub-procedure: Warm/cold-tier replica policy --- single-copy exposure

The core ILM policies (logs, metrics, logs-apm.app_logs-default_policy,
metrics-apm.app_metrics-default_policy, traces-apm.traces-default_policy,
and the per-signal metrics-apm aggregate policies) set
allocate.number_of_replicas: 0 in the warm phase (min_age 3d; 4d for
transaction_1m).

A backing index therefore runs a single copy from roughly 3 to 14 days
of age --- through the warm and cold phases --- until it converts to an
S3-backed frozen searchable snapshot. A warm or cold node restart or
replacement orphans those replica-0 primaries and takes their indices
RED until recovery. This was the 2026-05-15 eu-b2b incident: 96
unassigned primary shards across 167 data streams.

Hot-phase write indices are unaffected --- they correctly carry 1
replica.

## §3.15.1 Detect

Read each core policy and inspect the warm phase. Any policy with a
warm-phase allocate action setting the replica count to 0 carries this
exposure for every stream it manages.

    GET _ilm/policy/logs,metrics,traces-apm.traces-default_policy
    # inspect phases.warm.actions.allocate.number_of_replicas

## §3.15.2 Fix

For streams that must stay searchable through a single node loss --- APM
traces and logs, Kong production logs, core metrics --- raise the
warm-phase replica count to 1 and leave cold and frozen at 0. PUT
_ilm/policy replaces the whole policy document, so GET the current
policy first, change only
phases.warm.actions.allocate.number_of_replicas, and PUT the complete
policy back. The policy edit takes effect on the next phase transition;
existing warm and cold backing indices already at 0 replicas need a
one-off settings call to gain a copy immediately.

    PUT .ds-logs-apm.app.*,.ds-traces-apm-*,.ds-logs-kong.*/_settings
    { "number_of_replicas": 1 }

-   Confirm the target tier has at least two data nodes and disk
    headroom before raising replicas --- otherwise the new copies stay
    unassigned. On eu-b2b the warm tier has two nodes with ample free
    space.

-   Leave cold and frozen at 0. Cold is read-only and lower-cost; frozen
    is an S3-backed searchable snapshot and recoverable. Confining the
    replica to the warm band keeps the extra storage cost small.

-   APM-bundled policies (logs-apm.app, metrics-apm.app,
    traces-apm.traces) may auto-revert on Fleet package update ---
    re-apply after stack upgrades, as in §3.9 and §8.2.

## §3.15.3 Validation

Cross-ref §9.1 (After an ILM policy change):

-   _cluster/health returns GREEN, 0 unassigned shards.

-   _cat/shards/.ds-logs-apm.app.*-*?h=index,shard,prirep,node shows
    each warm backing index with both a primary and a replica.

-   Warm-tier disk usage rises by the expected per-stream amount; if
    not, replicas failed to allocate --- check tier headroom.

## §3.5 TB on eu-cld during the 21 April incident), the raise is a tactical

fix, not a new steady state. Without follow-up, the estate pays for the
higher ceiling permanently even after the retention audit and frozen
tuning land their savings.

-   Step 1 (incident): raise ceiling; record the new ceiling value and
    the exact reason (watermark event, query pattern) in the policy
    change register (§8.1).

-   Step 2 (planned): once §3.3.2 (frozen tuning), §8.3 (retention
    audit), and any stream-specific ILM changes have fully aged through
    (minimum 14 days so new frozen min_age takes effect), re-measure
    actual usage.

-   Step 3 (downsize): drop the ceiling back --- not necessarily to the
    original value; target actual usage × 1.25 as the new ceiling.
    Document the downsize in the policy change register with
    before/after usage figures.

-   This two-step is the default posture. A permanent ceiling raise
    should require explicit cost-owner sign-off.

