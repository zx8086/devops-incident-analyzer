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
_Promoted to skill `skills/dead-data-stream-cleanup/`._

## §3.7.1 Detect

GET

    _data_stream/*?filter_path=data_streams.name,data_streams.generation,data_streams.indices.index_name
    # Cross-reference against indices with 0 docs in last 7 days:
    GET

_cat/indices/.ds-*?h=index,docs.count,creation.date&s=creation.date&format=json

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

-   Delete the data stream: DELETE _data_stream/.

-   Verify no matching index templates will re-create it on next ingest.

## §3.8 Sub-procedure: Orphan index reattachment
_Promoted to skill `skills/orphan-index-reattachment/`._

## §3.8.1 Detect

GET _cat/indices/<pattern>*?h=index,ilm.policy&v
    # Filter rows where ilm.policy is blank or 'null'

## §3.8.2 Reattach

PUT <index>/_settings
    { "index.lifecycle.name": "<target-policy>",
    "index.lifecycle.rollover_alias": "<alias>" // only for
    alias-based streams
    }

-   The ILM age counter resets to 0 at reattachment --- keep this in
    mind for delete timing on already-old data.

-   Always reattach to the same policy the new indices in that stream
    are using --- diverging policies cause split retention.

-   Verify with GET /_ilm/explain --- expect policy field populated and
    phase=hot\|warm\|cold (not null).

## §3.9 Sub-procedure: Built-in ILM policy revalidation after upgrade
_Promoted to skill `skills/built-in-ilm-policy-revalidation-after-upgrade/`._

## §3.9.1 Post-upgrade check

GET _ilm/policy/metrics
    GET _ilm/policy/logs
    GET _ilm/policy/synthetics
    GET _ilm/policy/profiling
    GET _ilm/policy/@lifecycle
    # Compare phases against git-stored baseline; alert if phase count !=

expected

## §3.9.2 Permanent fix

-   Never depend on built-in policies for production data. Copy to a
    custom name (e.g. logs-custom) and update index templates to
    reference the custom one.

-   Leave the built-ins as Elastic ships them so upgrades don't
    conflict.

-   Add a weekly scheduled check in the monitoring cluster: assert phase
    count on custom policies is unchanged since last baseline commit.

## §3.10 Sub-procedure: Dedicated ILM policy for high-retention network-logs streams
_Promoted to skill `skills/dedicated-ilm-policy-for-high-retention-network-logs-streams/`._

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
_Promoted to skill `skills/ilm-rollover-guard-semantics/`._

## §3.13 Sub-procedure: Empty retention-fleet templates inherit prod ILM
_Promoted to skill `skills/empty-retention-fleet-templates-inherit-prod-ilm/`._

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

## §3.14 Sub-procedure: Override index template pattern (priority 300)
_Promoted to skill `skills/override-index-template-pattern-priority-300/`._

## §3.15 Sub-procedure: Warm/cold-tier replica policy --- single-copy exposure
_Promoted to skill `skills/warmcold-tier-replica-policy/`._

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
    re-apply after stack upgrades, as in 3.9.

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

