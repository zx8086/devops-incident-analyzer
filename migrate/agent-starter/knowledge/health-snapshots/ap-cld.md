**Cluster Health & Cost Optimisation Report**

ap-cld \| Elasticsearch 9.2.3 \| Elastic Cloud (AWS ap-east-1)

13 March 2026

Executive Summary

The ap-cld cluster is GREEN and operationally stable, running ES 9.2.3
across 11 nodes in a 3-AZ deployment (ap-east-1a/b/c). The cluster
serves as a cross-cluster search peer alongside us-cld and eu-cld. There
are 0 ILM errors, 0 pending tasks, and 0 active forcemerge tasks at time
of assessment.

However, ap-cld shares the same fundamental structural deficiencies
found and remediated on eu-b2b, eu-cld, and us-cld:

-   **basic-lifecycle-metrics has no delete phase** --- 4,238 indices
    (85% of all indices) accumulate on the frozen tier indefinitely,
    including 222 indices from 2024. The frozen node is at 90% local
    cache utilisation.

-   **No warm tier exists** --- zero warm nodes are provisioned. All 8
    core ILM policies skip the warm phase entirely. No indices receive
    shrink, force-merge, or replica reduction before reaching cold.

-   **Cold tier stores full replicas** --- all cold indices retain
    number\_of\_replicas: 1, approximately doubling cold storage
    consumption (\~200 GB wasted).

-   **50 GB rollover threshold** --- all core policies use
    max\_primary\_shard\_size: 50 GB (vs the 2 GB standard applied on
    eu-b2b and eu-cld), creating oversized shards.

-   **18 APM policies are hot-only** --- no tier transitions; 390-day
    60m aggregation data sits on hot storage.

The cluster is not in crisis today, but the missing delete phase on
basic-lifecycle-metrics means frozen tier growth is unbounded. At
current ingestion rates, the frozen node will exhaust its local cache
within weeks.

1\. Infrastructure Overview

1.1 Cluster Topology (Verified 13 March 2026)

  -------------- ---------- --------------- ---------------- ----------------- ---------------------
  **Instance**   **Role**   **RAM / JVM**   **Disk Total**   **Disk Used %**   **AZ**
  \#054          hot        16 GB / 8 GB    192 GB           **82%**           ap-east-1c (zone-1)
  \#055          hot        16 GB / 8 GB    192 GB           **73%**           ap-east-1a (zone-2)
  \#060          hot        16 GB / 8 GB    192 GB           61%               ap-east-1b (zone-0)
  \#031          cold       4 GB / 2 GB     296 GB           62%               ap-east-1a (zone-2)
  \#056          cold       4 GB / 2 GB     296 GB           66%               ap-east-1b (zone-1)
  \#059          cold       4 GB / 2 GB     296 GB           56%               ap-east-1c (zone-0)
  \#061          frozen     8 GB / 4 GB     592 GB           **90%**           ap-east-1b (zone-0)
  \#057          master     4 GB / 2 GB     48 GB            \<1%              ap-east-1a (zone-0)
  \#062          master     4 GB / 2 GB     48 GB            \<1%              ap-east-1b (zone-2)
  \#063          master     4 GB / 2 GB     48 GB            \<1%              ap-east-1c (zone-1)
  \#036          ml         1 GB / 408 MB   12 GB            \<1%              ap-east-1a (zone-0)
  -------------- ---------- --------------- ---------------- ----------------- ---------------------

1.2 Key Observations

-   **No warm tier:** 0 warm nodes provisioned. This is the same gap
    found on eu-cld (which had warm nodes but 1 GB JVM, effectively
    unusable) but worse --- ap-cld has no warm infrastructure at all.

-   **Single frozen node:** Unlike eu-cld (3 frozen nodes) and eu-b2b (3
    frozen), ap-cld has only 1 frozen node (instance-0000000061, 592 GB
    disk, 90% used). This is a single point of failure for the
    searchable snapshot cache.

-   **Hot tier imbalance:** Instance \#054 at 82% disk vs \#060 at 61%
    --- 21-percentage-point spread. Shard allocation is uneven.

-   **Cold JVM at 82--86%:** Cold nodes \#031 and \#056 show JVM heap at
    82--86%. With only 2 GB heap on 4 GB machines, these are operating
    at the margin.

2\. Cluster Statistics (Live --- 13 March 2026)

  -------------------------- --------------------------------------------------------
  **Metric**                 **Value**
  Cluster Status             **GREEN**
  Elasticsearch Version      9.2.3
  Total Nodes                11 (3 hot, 3 cold, 1 frozen, 3 master, 1 ML)
  Warm Nodes                 **0 (no warm tier provisioned)**
  Total Indices              4,994 (4,394 frozen + 600 hot/cold)
  Total Shards               5,663 (4,995 primary + 668 replica)
  Total Documents            76.4 billion
  Total Data Set Size        \~10.4 TB (primary) / \~10.6 TB on disk
  Frozen Tier (S3-backed)    \~9.9 TB searchable snapshots
  Pending Tasks              0
  ILM Errors                 0
  Forcemerge Tasks Running   0
  Region / AZs               ap-east-1 (a, b, c)
  Cross-Cluster Search       Connected to us-cld and eu-cld
  ILM Policies               78 total (8 core custom, 18 APM, rest built-in/system)
  Query Cache Hit Rate       29% (114M hits / 396M total)
  -------------------------- --------------------------------------------------------

3\. ILM Policy Landscape

78 ILM policies are configured. The 8 core custom policies govern the
vast majority of data:

  ----------------------------- ------------- ---------------- ------------------ -------------- ------------ ------------ -----------------
  **Policy**                    **Indices**   **Warm Phase**   **Cold Actions**   **Rollover**   **Frozen**   **Delete**   **Retention**
  **basic-lifecycle-metrics**   4,238         **NONE**         set\_priority      50 GB          7d           **NONE**     **∞ (forever)**
  **basic-lifecycle-logs**      333           **NONE**         set\_priority      50 GB          7d           90d          90 days
  ap-default-\*-prod (x3)       91+           **NONE**         set\_priority      50 GB          7d           90d          90 days
  ap-default-\*-nonprod (x3)    31+           **NONE**         set\_priority      50 GB          3d           30d          30 days
  ----------------------------- ------------- ---------------- ------------------ -------------- ------------ ------------ -----------------

**Critical gap:** Every core policy shares the same structural
deficiencies: no warm phase (no shrink, no force-merge, no replica
reduction), cold phase with set\_priority only (no replica removal), and
50 GB rollover size. basic-lifecycle-metrics additionally has no delete
phase at all.

All 18 APM policies are confirmed as hot → delete only, with no tier
transitions. The 60-minute aggregation policies (service\_destination,
service\_summary, service\_transaction, transaction) retain for 390 days
on hot storage.

4\. Key Findings & Optimisation Opportunities

  --------------------------------------------- ----------------- ------------- --------------------------------------------------------------
  **Finding**                                   **Severity**      **Section**   **Impact**
  basic-lifecycle-metrics has no delete phase   **CRITICAL**      4.1           4,238 indices grow forever; frozen tier at 90%
  No warm phase on any core policy              **CRITICAL**      4.2           No shrink/forcemerge/replica reduction; doubles cold storage
  Frozen tier at 90% utilisation                **CRITICAL**      4.3           Single frozen node; S3 cache near capacity
  Hot node \#054 at 82% disk                    **HIGH**          4.4           Approaching high watermark; imbalanced shard distribution
  50 GB rollover creates oversized shards       **HIGH**          4.5           \~1 GB shards across all data streams; rollover too large
  Cold tier replicas = 1 on all indices         **HIGH**          4.6           \~200 GB wasted on duplicate cold data
  No APM tier transitions                       **MEDIUM-HIGH**   4.7           18 APM policies hot-only; 390d aggregations on hot storage
  3 empty security\_solution indices            **LOW**           4.8           Minor shard waste; cleanup candidate
  --------------------------------------------- ----------------- ------------- --------------------------------------------------------------

4.1 basic-lifecycle-metrics Has No Delete Phase (CRITICAL)

This is the identical issue resolved on us-cld on 11 March 2026. The
basic-lifecycle-metrics policy governs 4,238 indices (85% of all indices
on the cluster) and has phases: hot → cold → frozen --- with no delete
phase. Every metric index ever ingested remains on frozen storage
indefinitely.

The impact is severe:

-   222 frozen metric indices date from 2024 --- over 14 months old and
    still consuming S3 cache

-   3,576 frozen metric indices from 2025 continue to accumulate

-   The single frozen node is at 90% disk --- it will hit the flood
    stage watermark without intervention

-   At current ingestion rates (\~30--40 new metric indices per day
    entering frozen), the frozen node will exhaust within 2--3 weeks

> **⚠ WARNING:** On us-cld, the same missing delete phase caused
> \~36,000 frozen metric indices to accumulate, triggering a master task
> overload incident. ap-cld has far fewer indices today but follows the
> same trajectory.

**Recommendation:** Add a 90-day delete phase to basic-lifecycle-metrics
as the first implementation action. Use the phased approach validated on
us-cld (365d → 180d → 90d) to avoid overwhelming the master with
deletion bursts.

4.2 No Warm Phase on Any Core Policy (CRITICAL)

ap-cld has zero warm nodes provisioned. All 8 core ILM policies
transition directly from hot to cold, skipping the warm phase entirely.
This means:

-   **No shrink:** Multi-shard indices reach cold without consolidation,
    inflating the total shard count.

-   **No force-merge:** Indices arrive on cold with many Lucene segments
    (29,610 segments across the cluster), increasing I/O cost.

-   **No replica reduction:** Replicas are set to 0 only implicitly when
    indices move to frozen (searchable snapshots). Cold indices retain
    full replicas.

**Recommendation:** Provision warm nodes (minimum 4 GB RAM / 2 GB JVM
per node, recommended 8 GB based on us-cld lessons). Add warm phase to
all core policies: shrink to 1 shard, force-merge to 1 segment, replicas
to 0. Set warm min\_age to 3d initially (can reduce to 1d after
validation).

4.3 Frozen Tier at 90% Utilisation (CRITICAL)

The single frozen node (instance-0000000061) has 592 GB total disk with
only 59 GB free (90% used). This node caches searchable snapshot data
backed by S3.

Unlike eu-cld (3 frozen nodes at 91%) and eu-b2b (3 frozen nodes),
ap-cld has only 1 frozen node. This creates:

-   No cache redundancy --- if the node fails, all frozen tier queries
    must fetch directly from S3

-   No rebalancing capability --- hot cache data cannot be redistributed

-   Imminent capacity exhaustion --- with 4,238 metric indices that
    never delete, growth is unbounded

**Recommendation:** Verify frozen tier S3 storage limits in Elastic
Cloud console. Consider requesting a frozen tier max-autoscale increase
as a prerequisite before implementation. The 90-day delete phase on
basic-lifecycle-metrics is the primary relief valve.

4.4 Hot Tier Disk Imbalance (HIGH)

Hot nodes show significant disk utilisation spread: \#054 at 82%, \#055
at 73%, \#060 at 61%. The 21-percentage-point gap between \#054 and
\#060 indicates uneven shard distribution. Instance \#054 is approaching
the high watermark (90% by default), which would trigger shard
relocation.

**Recommendation:** Reducing rollover from 50 GB to 2 GB will create
more, smaller shards that balance more evenly. Force-rollover of any
oversized active shards may provide immediate relief.

4.5 50 GB Rollover Creates Oversized Shards (HIGH)

All core policies use max\_primary\_shard\_size: 50 GB. In practice, the
daily max\_age: 1d / 24h rollover fires first, creating \~1 GB daily
shards. However, the 50 GB limit means that if daily rollover fails or
data volume spikes, a single shard could grow to 50 GB before rolling.
The eu-b2b and eu-cld standard is 2 GB.

**Recommendation:** Reduce max\_primary\_shard\_size from 50 GB to 2 GB
on all core policies.

4.6 Cold Tier Replicas = 1 (HIGH)

All cold-tier indices retain number\_of\_replicas: 1. Verified on sample
indices across both metric and log data streams. The cold tier holds
approximately 400 GB of primary data across 3 nodes; with replicas, this
consumes \~600 GB total.

Since data is also backed by S3 searchable snapshots on the frozen tier,
cold-tier replicas provide no durability benefit --- only availability
during cold-tier node failure. Removing replicas would free
approximately 200 GB across cold nodes.

**Recommendation:** Add number\_of\_replicas: 0 to the cold phase of all
core ILM policies. This is non-destructive and takes effect as new
indices transition to cold.

4.7 APM Policies Missing Tier Transitions (MEDIUM-HIGH)

All 18 APM policies are hot → delete only, identical to the
configuration found on eu-cld. The 60-minute aggregation policies
(service\_destination\_60m, service\_summary\_60m,
service\_transaction\_60m, transaction\_60m) retain for 390 days on hot
storage. Adding warm/cold/frozen phases would move this data off the
most expensive tier.

Note: No APM indices currently exist on ap-cld. The policies are defined
but no APM data streams have been created. This means APM optimisation
can be deferred until APM is actively used.

4.8 Empty security\_solution Indices (LOW)

3 security\_solution indices exist with 0 documents:
aws.misconfiguration\_latest-v3, awsinspector.vulnerability\_latest-v1,
awsconfig.misconfiguration\_latest-v1. These consume minimal resources
(3 shards) but should be reviewed for cleanup.

5\. Top Volume Drivers

The frozen tier is dominated by metric data streams that will never be
deleted under the current basic-lifecycle-metrics policy:

  ---------------------------- ---------- -------------------- ------------------------- ----------------------------------------------------
  **Data Stream**              **Type**   **Frozen Indices**   **Policy**                **Notes**
  metrics-windows.service-\*   Metric     **665**              basic-lifecycle-metrics   Largest frozen indices (180M docs each); no delete
  metrics-windows.perfmon-\*   Metric     \~300+               basic-lifecycle-metrics   Per-process CPU/working set; redundancy candidate
  metrics-vsphere.network-\*   Metric     309                  basic-lifecycle-metrics   \~31M docs per index; never deleted
  logs-cisco\_meraki.log-\*    Log        \~200                basic-lifecycle-logs      100M docs/day; rolls 3x/day; has delete (90d)
  logs-cisco\_ftd.log-\*       Log        \~200                basic-lifecycle-logs      100M docs/day; has delete (90d)
  metrics-system.process-\*    Metric     \~200                basic-lifecycle-metrics   Per-process metrics; no delete
  ---------------------------- ---------- -------------------- ------------------------- ----------------------------------------------------

windows.service is the single largest volume driver on ap-cld, identical
to the pattern found on us-cld. At 665 frozen indices with \~180M docs
each, this data stream alone accounts for an estimated 3--4 TB of frozen
S3 data.

> The same windows.service scoping recommendation from the us-cld
> assessment applies here: restricting the metricset to critical
> services only could reduce metric volume by 50--80%.

6\. Comparison with Peer Clusters

ap-cld shares identical structural deficiencies with eu-cld
(pre-remediation) and us-cld (pre-remediation):

-   Missing warm phase: same as eu-cld (which had underprovisioned
    warm), worse than eu-b2b (remediated)

-   Missing delete on basic-lifecycle-metrics: identical to us-cld
    (caused task overload incident 10 March)

-   50 GB rollover: same as eu-cld; eu-b2b has been reduced to 2 GB

-   Cold replicas = 1: identical across all three clusters
    pre-remediation

-   Single frozen node: unique to ap-cld (eu-cld and eu-b2b both have 3
    frozen nodes)

The ap-cld cluster is smaller than its peers (11 nodes vs 19 on eu-cld,
\~20 on eu-b2b) and currently under less pressure, but it is on the same
trajectory that caused incidents on us-cld and capacity alerts on
eu-cld.

7\. Estimated Cost & Storage Impact

7.1 Phase A: Structural Optimisations (Immediate)

-   Frozen tier relief: Adding 90-day delete to basic-lifecycle-metrics
    will remove \~3,500+ indices (all 2024 + most of 2025) over the
    first 90-day cycle, freeing \~8--10 TB of S3 storage

-   Cold storage: Removing replicas frees \~200 GB across cold nodes

-   Hot tier: Reducing rollover to 2 GB improves shard balance and
    reduces per-shard overhead

-   Warm processing: Adding shrink/forcemerge/0-replicas reduces segment
    count and cold-tier footprint

7.2 Phase B: Node Downsizing (Post-Validation)

After ILM changes are validated and frozen tier pressure is relieved,
cold-tier node downsizing can be evaluated. The cold tier is currently
56--66% utilised; with replicas removed, this drops to \~30--35%.

7.3 Prerequisites

-   **Provision warm tier:** Minimum 4 GB RAM per node (3 nodes for AZ
    coverage). 8 GB recommended based on us-cld OOM lessons.

-   **Verify frozen S3 headroom:** Check Elastic Cloud console for
    frozen tier S3 storage limit vs current usage before starting.

-   **Phased delete rollout:** Use 365d → 180d → 90d stepping on
    basic-lifecycle-metrics delete phase to avoid deletion burst (us-cld
    lesson).

-   **Staggered ILM updates:** Maximum 2--3 policies per day (eu-cld
    lesson: all policies at once caused 56 concurrent forcemerges and
    warm node OOM).

8\. Recommended Next Steps

The following actions are listed in priority order:

-   **1. Add delete phase to basic-lifecycle-metrics** (CRITICAL) ---
    phased rollout: 365d first, then 180d, then 90d target. Monitor
    frozen tier utilisation between phases.

-   **2. Provision warm tier** (CRITICAL prerequisite) --- minimum 4 GB
    RAM x 3 nodes. Must be in place before any warm-phase ILM changes.

-   **3. Verify frozen tier S3 headroom** (CRITICAL prerequisite) ---
    check Elastic Cloud console before starting implementation.

-   **4. Produce full implementation plan** --- following the eu-cld
    template with ap-cld-specific policy names, index counts, and us-cld
    lessons incorporated.

-   **5. Agent collection audit** (parallel workstream) ---
    windows.service scoping, windows.perfmon redundancy check, system.\*
    collection periods.

*Report generated from live cluster data (Elasticsearch MCP tools) on 13
March 2026.*
