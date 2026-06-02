# 6. Index and data hygiene

Source: Elastic_Optimisation_Playbook_v12 §6 (reference content).

## §6.1 Weekly hygiene pass

-----------------------

-   Orphan index scan: any index whose policy is null → reattach or
    delete.

-   Empty backing indices: any .ds-* with 0 docs older than 2d → remove
    (see §3.7).

-   Unmanaged indices: any index not matching an index template →
    investigate, usually a one-off that should either be productised or
    deleted.

-   Dead data streams: streams with 0 ingest in last 7d → confirm owner,
    delete.

-   Policy drift: run §3.4 monthly, always after upgrade.

## §6.2 Shard balance

-----------------

Shard count is cost. Target metrics by cluster size:

-   \<10 nodes: keep under 3,000 shards. eu-b2b currently 2,843 after
    cleanup.

-   10--30 nodes: 5,000--10,000 shards reasonable.

-   30 nodes: 15,000+ if necessary, but investigate before growing.

-   Hot node imbalance (e.g. eu-b2b hot-0095): use GET
    _cat/allocation?v to spot skew; move shards with POST
    _cluster/reroute or adjust allocator settings.

## §6.3 Enrich policy source discovery --- do not delete before checking

--------------------------------------------------------------------

Pattern: an index looks like an orphan (no ILM policy, no index
template, small size, unchanged in days). Before deleting, check if it
is the source for an enrich policy --- those are intentionally un-ILM'd
because enrich indices are pointers to a frozen snapshot at
_enrich/policy//_execute time.

## §6.3.1 How to tell

GET _enrich/policy
    # Look at 'indices' field in each policy --- any of those names match
    your 'orphan'?
    # Also check index templates for matching patterns in

_meta.enrich_source

## §6.3.2 Worked example

On eu-cld: storewatch-* and store-details looked orphaned.
Investigation revealed they were enrich sources for the logs-storewatch
enrich policy, executed nightly. Deleting them would have silently
broken enrichment on the live stream.

Standard: attach a _meta tag to known enrich source indices so future
operators spot them:

    PUT storewatch-lookup-v3/_settings
    { "_meta": { "role": "enrich-source", "policy":
    "logs-storewatch", "do_not_delete": true } }

## §6.4 Rollover threshold consolidation

------------------------------------

Problem: eu-cld had 786 indices under eu-default-lifecycle-metrics-prod
because the rollover threshold was 2 GB (the standard is 10 GB). 5
rollovers/day per shard → 3,900 rollover operations/day on this policy
alone.

## §6.4.1 Diagnose

GET _ilm/policy/*/phases/hot/actions/rollover
    # Sort by max_primary_shard_size; flag any <5gb on non-metrics

policies, any \<1gb anywhere

## §6.4.2 Fix

Raise threshold on the policy definition:

    PUT _ilm/policy/eu-default-lifecycle-metrics-prod
    { "policy": { "phases": { "hot": { "actions": { "rollover": {
    "max_primary_shard_size": "10gb", "max_age": "1d" }, ... }
    } } } }

-   Existing indices keep their current size; new rollovers will follow
    the new threshold.

-   Optional: reindex or force-rollover small existing indices if disk
    pressure demands faster consolidation.

-   Rule: document any policy with max_primary_shard_size ≠ 10--25 GB
    in the policy description field with a justification.

6.5 logsdb mode for log datasets
--------------------------------

logsdb (introduced in 9.0) provides automatic synthetic source plus
host-name sorting, yielding 30--50% storage reduction on log data on top
of best_compression. Three nonprod templates on eu-cld already use it
(logs-gkapps-nonprod, logs-java-nonprod, logs-plm-nonprod).

## §6.5.1 When to apply

Target heavy-volume log datasets in production: -
kubernetes.container_logs (\~691M docs/day on eu-cld) -
cisco_meraki.log, cisco_ftd.log (\~350M each) - system.syslog -
windows.application - Any custom high-volume log streams

Skip: - APM streams (own optimisation path) - OTEL collector data
(generic.otel) which has its own pipeline - Streams with very-low-volume
that won't benefit measurably

## §6.5.2 How to apply

Use the override template pattern (§3.14) with index.mode: logsdb.
Settings apply on next rollover; existing backing indices keep their
current mode.

## §6.5.3 Risk and validation

-   Some text full-text scoring queries return slightly different
    results because logsdb stores text differently. Validate against
    your common query patterns before broad rollout.

-   Reversal: DELETE _index_template/\<name\>-logsdb. Existing
    logsdb-mode indices remain logsdb until aged out; new rollovers
    return to standard mode.

-   Monitor query latency for 48h after activation on each dataset.

## §6.6 Synthetic source --- already covered by TSDB on Fleet metrics

-----------------------------------------------------------------

Fleet metric integrations on 9.x ship templates with mode: time_series
(TSDB), which automatically uses synthetic source. Verified on eu-cld:
metrics-kubernetes.container, metrics-system.cpu, and similar templates
all use TSDB and therefore synthetic source by default.

-   No separate synthetic source action is required for Fleet-managed
    metric datasets --- they already use it.

-   The remaining stored-source indices on a typical cluster are
    dominated by logs (covered by logsdb in §6.5), APM (own
    optimisation), and OTEL collector data (own pipeline path).

-   Verify on a target cluster: GET
    _cluster/stats?filter_path=indices.mappings.source_modes ---
    ratio of synthetic vs stored.

-   For non-Fleet metric streams that show as stored-source, evaluate
    case-by-case whether explicit synthetic source via the override
    template pattern (§3.14) is appropriate. Be aware of compatibility
    constraints (text fields, geo_shape, some legacy types do not
    support synthetic source).

## §6.7 Sub-procedure: Stream consolidation via reroute processor
_Promoted to skill `skills/stream-consolidation-via-reroute-processor/`._

## §6.7.1 The consolidation pipeline

PUT _ingest/pipeline/metrics-kubernetes.state-consolidate
    {
      "description": "Consolidate per-namespace kubernetes.state_* streams into one stream per subtype.",
      "processors": [
        { "set": { "field": "labels.environment", "copy_from": "data_stream.namespace", "ignore_empty_value": true, "override": false } },
        { "set": { "field": "orchestrator.cluster.name", "copy_from": "data_stream.namespace", "ignore_empty_value": true, "override": false } },
        {
          "reroute": {
            "namespace": "default",
            "if": "ctx?.data_stream?.dataset != null && ctx.data_stream.dataset.startsWith('kubernetes.state_')"
          }
        }
      ],
      "on_failure": [
        { "set": { "field": "event.kind", "value": "pipeline_error" } },
        { "set": { "field": "error.message", "value": "{{{ _ingest.on_failure_message }}}" } }
      ]
    }

## §6.7.2 Wire-in via \@custom hooks

For each subtype (state_pod, state_replicaset, state_container, ...):

    PUT _ingest/pipeline/metrics-kubernetes.state_pod@custom
    {
      "processors": [
        { "pipeline": { "name": "metrics-kubernetes.state-consolidate" } }
      ]
    }

The Fleet integration's native pipeline calls \<dataset\>\@custom as a
final step, so this insertion is non-invasive and survives package
upgrades.

## §6.7.3 Risks and rollout

-   Audit Kibana dashboards that filter on data_stream.namespace before
    activation --- those filters need to switch to labels.environment.

-   Convert RBAC roles scoped to specific namespaces by stream name to
    Document Level Security on labels.environment.

-   Inventory ML jobs and update feeds.

-   Roll out one subtype at a time; each \@custom wiring is
    independently reversible via DELETE
    _ingest/pipeline/\<dataset\>\@custom.

## §6.8 Hot-node low-watermark relief and single-shard reshard
_Promoted to skill `skills/hot-node-low-watermark-relief-and-single-shard-reshard/`._

## §6.8.1 Interim relief --- allocation-filter reroute

Move specific shards off the pressured node onto the under-used one,
then remove the filter so nothing stays pinned:

    PUT <index>/_settings
    { "index.routing.allocation.exclude._name": "instance-XXXX" }
    # wait for relocation: GET _cluster/health until relocating_shards = 0
    PUT <index>/_settings
    { "index.routing.allocation.exclude._name": null }

-   Pick shards whose other copy is not already on the target node to
    avoid primary/replica co-location.

-   Safe on a GREEN cluster; relocations are recovery-throttled (\~40
    MB/s), so a \~10 GB shard takes a few minutes.

-   Removing the filter does not bounce the shard back --- the allocator
    will not move it into the fuller node.

## §6.8.2 Durable fix --- reshard the oversized index

For a content index that only grows (no ILM roll-off), reindex it into
multiple primary shards so it distributes across all nodes and each
shard stays under \~50 GB. Use an alias so future reshards need no
consumer changes. us-cld worked example (24 May 2026):
mulesoft-aggregations-prod-v6, \~168M docs / 103 GB in one shard,
planned to 3 primaries --- see
us-cld_mulesoft_aggregations_reindex_plan_v1.

## §6.8.3 Check the source Transform state before reshard

A pre-created destination index that has sat empty for weeks is a strong
signal the migration was paused. Before reindexing, find the Transform
(or other writer) that targets the source index and confirm its current
state and last successful checkpoint.

Search .transform-internal-* for docs whose dest.index matches the
source. The latest data_frame_transform_checkpoint-\<id\>-\<N\> doc
shows the last checkpoint number and its timestamp_millis. If that
timestamp is stale, the Transform stopped writing then; the source index
is effectively static.

Verify by counting source docs twice with a delay; if the count is
stable, no live writes are happening.

A stopped Transform changes the reshard runbook. No write-pause or
dual-write window is needed for the reindex; cutover becomes an admin
step (update dest.index on the Transform and restart) or a retirement
step (delete the Transform), to be agreed with the data owner.

us-cld worked example (2026-05-26): the Transform
mulesoft-aggregations-prod-v6 had last checkpoint 71299 at 2026-03-22
02:11 UTC, 65 days stale. v6 doc count was stable at 168,367,922 over
two consecutive checks. The reshard reindex was started immediately
without a write-pause window; the cutover or retirement decision is held
with the Mulesoft team.

