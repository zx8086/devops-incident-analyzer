# 7. Infrastructure and cost

Source: Elastic_Optimisation_Playbook_v12 §7 (reference content).

## §7.1 Elastic Cloud plan change gotchas

-------------------------------------

The Cloud plan-change API (underneath the console) has sharp edges the
programme has hit repeatedly. Plans #187 through #194 on eu-cld
document this.

## §7.1.1 Warm disk full blocks all plan changes

-   Symptom: every plan attempt fails with exit code 74; error mentions
    a specific warm node.

-   Cause: Cloud will not change topology while any node is above the
    watermark. Warm tier has no autoscaling by default.

-   Fix: free warm-tier disk first --- raise replica count temporarily
    down on a warm-heavy policy, or accelerate migration of oldest warm
    indices to cold. Only then retry the plan.

## §7.1.2 ML shutdown API limitation

-   Symptom: plan change with ML nodes fails at the shutdown step; ML
    jobs don't stop cleanly.

-   Cause: platform-level bug in ES 9.2.x ML shutdown API --- jobs in
    certain states cannot be gracefully stopped via API.

-   Workaround: manually close all ML jobs before plan change: POST
    _ml/anomaly_detectors/*/_close. Re-open after.

## §7.1.3 Resize vs. remove

-   Rule: to remove a node from a tier, reduce the tier to
    current_size - 1 first; do not attempt to directly remove a
    specific node ID. Cloud reallocates, drains, then deletes.

-   Rule: to change instance type (e.g. hot SSD gen2 → gen3), do it as a
    separate plan from any size change. Combining triggers serial data
    migrations that can take hours.

## §7.2 Cold-tier autoscaling ceiling management

--------------------------------------------

Pattern observed on eu-cld: cold tier autoscaler maxed out at its
configured ceiling (2.17 TB) while actual usage hit 91% on one node. The
autoscaler does not silently exceed the ceiling --- it stops scaling and
alerts.

## §7.2.1 Monitoring

-   Run a weekly check of autoscaling policy GET _autoscaling/capacity
    --- compare required_capacity against current_capacity; alert when
    required \> 85 % of ceiling.

-   Cold tier specifically: watermark events in elastic.log are the
    earliest tripwire before disk actually fills.

## §7.2.2 Decision tree when cold hits ceiling

-   First: lower frozen min_age (§3.3.2). Moves data off cold, costs
    little.

-   Second: audit retention --- is anyone actually querying 60--90d data
    on this stream? Consider shortening delete phase (§8.3).

-   Third: raise the autoscaling ceiling. Document why; this is the
    cost-bearing option.

-   Fourth (rare): add another cold node out-of-band. Requires plan
    change (§7.1).

## §7.2.3 Raise-then-downsize two-step (incident pattern)
_Promoted to skill `skills/raise-then-downsize-two-step-incident-pattern/`._

## §7.3 Hot-tier I3 downsize after over-migration

---------------------------------------------

Pattern: during a migration from older hot-tier instance types to I3
SSD-backed instances, the sizing plan conservatively over-provisions
headroom. Once the migration has bedded in (typically 2--4 weeks of
stable ingest on I3 + shrunk shard counts from other ILM work), the hot
tier is commonly 30--50% over-sized.

-   Baseline: measure hot-tier peak disk used_percent and peak
    heap.percent over a rolling 7-day window.

-   Target: peak disk \<70%, peak heap \<65%. If both are consistently
    below that, the tier is a downsize candidate.

-   Execution: downsize one I3 size tier at a time (e.g. I3 58GB → I3
    29GB per node, not two sizes in one plan). Elastic Cloud serialises
    migrations per instance so each step takes a predictable window.

-   Gate: do §7.1.1 warm-disk check first and close ML jobs (§7.1.2)
    before the plan.

-   Validation: 48h after downsize completes, re-measure hot-tier ingest
    latency and JVM young-gen GC frequency --- if either degrades,
    revert is cheap (Cloud remembers the previous plan).

## §7.4 Ingest-volume creep detection

---------------------------------

-   Watch GET _cluster/stats indexing.index_total delta hour-over-hour
    --- a 20 %+ sustained rise without a known app change is an
    instrumentation regression.

-   Per-service breakdown via data_stream.dataset aggregation on the
    last 7 days --- any new dataset appearing is worth investigating.

-   Tie ingest spikes to release cadence: if spike correlates with a
    deploy, it is almost certainly an instrumentation change.

7.5 cluster.max_shards_per_node phased removal ladder
--------------------------------------------------------

Pattern: when the cluster has been running with
cluster.max_shards_per_node raised above the default 1,000, AutoOps
flags The number of allowed shards per cluster is higher than the
default. Closing the event requires removing the override entirely, but
doing so prematurely will reject new index creation.

## §7.5.1 The ladder

Ratchet the override down as ILM-driven shard reduction (§3.11) brings
counts down. Each step keeps \~10--15% headroom above the highest live
tier shard count.

  Day   Action            Trigger
  ----- ----------------- -----------------------------------------------------------------------
  0     leave as-is       New ILM rollover triggers applied; observe for 7 days
  +7    lower to 8,000    Hot \< 1,500/node, no ILM errors
  +14   lower to 6,000    Frozen ≤ 5,500/node (deletes from 90d retention firing)
  +28   lower to 4,000    Hot ≤ 1,000/node, frozen ≤ 3,500/node
  +57   lower to 2,000    Frozen ≤ 1,800/node (cluster fully cycled)
  +90   remove entirely   Frozen \< 1,000/node --- usually requires stream consolidation (§6.7)

## §7.5.2 Pre-flight before each step

GET _cluster/health
    GET _cat/nodes?v&h=name,node.role,shards&s=shards:desc
    GET _ilm/explain?only_errors=true

If any pre-flight fails the threshold for the planned step, defer to the
next observation window.

## §7.5.3 Rollback

If a lowering causes index creation rejections, raise immediately:

    PUT _cluster/settings
    { "persistent": { "cluster.max_shards_per_node": "10000" } }

Then investigate what spiked.

## §7.6 Synthetics browser monitor cost reduction

---------------------------------------------

Browser synthetics is billed per test run and is typically the largest
discretionary line in the Synthetics bill. On us-cld a measured 25,684
browser test runs per 24h came from 87 monitors, the large majority of
them vendor status-page checks running a 5-minute schedule across 3
locations. Three independent multipliers stack: frequency, number of
locations, and browser-versus-lightweight monitor type. Reduce all
three.

## §7.6.1 Detect

Count current browser runs over 24h: search synthetics-browser-*
filtered to summary present over now-24h and count the summary
documents. This is the billed test population.

Break it down: aggregate the same query by monitor.name and by
observer.geo.name to see which monitors and how many locations drive the
volume.

Read the per-monitor schedule from monitor.timespan (lt minus gte gives
the interval) and the location count via a cardinality aggregation on
observer.geo.name.

Identify pure status-page checks: monitor names ending in -status that
simply load a vendor status or health page are candidates to move off
the Browser SKU.

## §7.6.2 Reduce

Frequency: raise the schedule on status checks from 5 minutes to 15
minutes (roughly a two-thirds reduction on affected monitors). Vendor
status pages do not need 5-minute granularity.

Locations: reduce status monitors from 3 locations to 1 (a further
two-thirds reduction). A global vendor status page does not need 3
geographic vantage points.

Monitor type: convert pure status-page checks from browser monitors to
lightweight HTTP monitors hitting the status JSON or health endpoint.
Lightweight HTTP is roughly an order of magnitude cheaper than browser
and removes those checks from the Browser SKU entirely.

Consolidate duplicates: merge near-identical monitor families (for
example antavo-st1/st3/st4/st9/us6/us7/us-emea) into parameterised
monitors.

Trim data capture: disable network and screenshot capture on monitors
that do not need forensic detail. On us-cld the
synthetics-browser.network-e_commerce stream alone writes about 11
GB/day to the hot tier.

## §7.6.3 Risk and validation

Risk is low for frequency and location cuts. Converting to HTTP loses
screenshot and DOM detail but keeps up/down and latency; pick the right
endpoint per vendor.

Validate by re-running the 24h browser-summary count after the change
and confirming a step-change down, and by confirming each converted
monitor still reports up/down with no loss of true alerting coverage.

Expected outcome: frequency plus location cuts alone reduce the
status-monitor population by roughly 70 to 85 percent; converting to
HTTP moves them off the Browser line. On us-cld this is on the order of
44 to 53 thousand dollars per year at list (1 ECU is about 1 US dollar
at list; apply the committed-contract discount for net).

## §7.7 Hot-tier disk relief via warm.min\_age tuning

-------------------------------------------------

When a hot-tier node drifts toward the low watermark and a per-node
reroute is needed every few days, the root cause is usually not capacity
but that rolled-over indices linger in hot waiting on warm.min_age.
Each just-sealed index keeps occupying hot storage until that timer
elapses. Shortening it pushes data to warm sooner, freeing hot disk
within minutes of the next ILM evaluation pass.

## §7.7.1 Detect

Disk imbalance on the hot tier where one or two nodes sit near the low
watermark while others have ample room.

High ingest rate per data stream (for example traces-apm.rum-default
rolling many GB-sized backing indices per day).

Per-policy hot phase rollover triggers firing by size on the busy
streams (max_primary_shard_size hits before max_age).

warm.min_age set at 1d on the dominant policies; check via GET
_ilm/policy/\<name\> and look at the warm.min_age field.

## §7.7.2 Reduce

For each high-volume policy, PUT _ilm/policy/\<name\> with the same
body except warm.min_age changed from 1d to 6h (or 0d for maximum
effect). Preserve every other field exactly.

Apply via the Elastic MCP ilm_put_lifecycle tool or the cluster API.
Policy version increments automatically.

ILM evaluates managed indices every 10 minutes by default. Indices that
rolled over more than 6h ago will migrate to warm on the next pass.

Validate with GET _ilm/policy/\<name\> showing warm.min_age = 6h, then
GET _nodes/stats/fs and confirm the hot-tier node free space rises
within 30 to 60 minutes.

## §7.7.3 Risk and validation

Queries on data younger than one day move from the hot tier disk type
(typically SSD) to warm (typically larger d3 throughput-optimised). For
logs and traces this is usually fine; interactive APM dashboards on the
last 24h may be marginally slower.

Warm tier must have headroom. Check GET _nodes/stats/fs on warm nodes
before applying; warm at less than 50% used is comfortable.

Rollback is one PUT per policy with warm.min_age restored to 1d.

Applied 2026-05-26 03:29 UTC on us-cld to four policies:
traces-apm.rum_traces-default_policy v6, basic-lifecycle-logs v13,
us-default-lifecycle-logs-prod v6, basic-lifecycle-metrics v17. Trigger
was instance-0000000213 at 91% disk used, persistent after the
2026-05-24 reroute.

