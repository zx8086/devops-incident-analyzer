**Cluster Health & Cost Optimization Report**

us-cld \| Elasticsearch 9.2.3 \| Elastic Cloud (AWS us-east-1)

10 March 2026

Executive Summary

The us-cld cluster is rated GREEN by Elasticsearch but UNHEALTHY by
Elastic Cloud, running ES 9.2.3 across 17 data/master/coordinating nodes
in a 3-AZ deployment (us-east-1a/1b/1e). The current all-in hourly rate
is \$18.45/hr (\~\$13,450/month), with the frozen tier comprising the
largest storage footprint at 140.63 TB of searchable snapshot
(S3-backed) storage.

The cluster exhibits several critical issues requiring immediate
attention. The most severe is a missing delete phase on the
basic-lifecycle-metrics policy, which governs 36,222 indices (77% of all
indices). These metrics are retained indefinitely on frozen storage, and
this is the primary driver of the 140 TB frozen-tier footprint.
Additionally, the hot tier has hit its autoscaling limit, coordinating
nodes \#124 and \#125 are unhealthy, the pending task queue spiked to
9,272 during this assessment (with the cluster briefly going YELLOW),
and AutoOps has flagged 8 active alerts including circuit breaker trips
on 11 nodes.

Cost optimization opportunities closely mirror what was successfully
implemented on eu-b2b and planned for eu-cld: ILM structural
improvements (shrink, force-merge, replica reduction), tier transition
additions for APM/synthetics policies, and retention alignment. However,
us-cld has a unique and much larger issue---the indefinite metrics
retention---that makes this the highest-impact single finding across all
three clusters.

1\. Infrastructure Overview

1.1 Cluster Topology

  -------------------- ---------------------------------------------------------------------------
  **Deployment**       **Value**
  Name                 us-cld
  Deployment ID        971a5b
  Region               AWS us-east-1 (N. Virginia)
  ES Version           9.2.3 (all nodes)
  Availability Zones   3 (us-east-1a, us-east-1b, us-east-1e)
  Hardware Profile     CPU optimized (ARM) - Custom
  Total Nodes          17 ES + 3 Kibana + 3 Integrations Server + 2 ML
  Total Indices        46,910 (all green)
  Total Shards         51,672 (48,675 primary)
  Total Documents      \~243.6 billion
  Total Storage        \~147.71 TB (across all tiers incl. S3)
  Total Memory         296 GB
  Hourly Rate          \$18.45/hr (\$14.72 ES + \$1.57 Kibana + \$1.57 Integrations + \$0.58 ML)
  Monthly Estimate     \~\$13,450
  -------------------- ---------------------------------------------------------------------------

1.2 Tier-by-Tier Breakdown

  --------------- ----------- --------- ------------- ------------ ----------- --------------------------
  **Tier**        **Nodes**   **RAM**   **Storage**   **Disk %**   **JVM %**   **Instance Type**
  Hot + Content   3           90 GB     2.64 TB       42--72%      41--49%     aws.es.datahot.c6gd
  Warm            0\*         0 GB      0 TB          N/A          N/A         Not provisioned
  Cold            3           24 GB     4.45 TB       38--69%      70--77%     aws.es.datacold.d3
  Frozen          3           90 GB     140.63 TB     S3-backed    72%         aws.es.datafrozen.i3en
  Master          3           24 GB     216 GB        \<1%         7--42%      aws.es.master.c6gd
  Coord/Ingest    3           12 GB     52 GB         \<2%         56--76%     aws.es.coordinating.m6gd
  ML              2           8 GB      48 GB         \<1%         ---         aws.es.ml.c5d
  --------------- ----------- --------- ------------- ------------ ----------- --------------------------

*\* Warm tier is allocated (max 380 GB/zone, 2 GB RAM) but current size
is 0 MB. No data is routed through warm.*

1.3 Capacity Alerts

**CRITICAL: Three data tiers (hot, cold, frozen) show LIMIT REACHED on
autoscaling. Current size equals maximum size, meaning the cluster
cannot scale up automatically to handle data growth.**

Hot tier: Instance \#181 at 72% and \#177 at 70% disk. \#179 at 42%
suggests uneven shard distribution. All three at autoscaling limit (900
GB/zone).

Cold tier: Instance \#170 at 69% with JVM at 77% (HIGH). Cold JVM memory
reported at 87% by AutoOps---this is approaching dangerous territory.
\#169 at 56%, \#182 at 38%.

Frozen tier: 140.63 TB at autoscaling limit (46.88 TB/zone). System
memory at 96% per AutoOps. Each frozen node has only \~100 GB free cache
out of 2.38 TB total.

Coordinating nodes: \#125 (us-east-1b) and \#124 (us-east-1e) are
UNHEALTHY per Elastic Cloud. \#126 has JVM at 76% (HIGH). These nodes
are under pressure from the 52K shard count.

2\. AutoOps Active Alerts

  ------------------------------------------------- -------------- --------------- -------------
  **Alert**                                         **Severity**   **Opened**      **Count**
  **Too many pending tasks**                        **HIGH**       2 minutes ago   1
  Some coordinating nodes more loaded than others   MEDIUM         1 hour ago      1
  CPU utilization on node is high                   MEDIUM         2 hours ago     3 nodes
  Circuit breaker tripped count is high             MEDIUM         4 hours ago     11 nodes
  More shards per node than recommended             MEDIUM         16 hours ago    6 nodes
  Many shards in the cluster are empty              MEDIUM         2 months ago    1
  Template can be optimized                         MEDIUM         6 months ago    6 templates
  Management queue size is high                     LOW            22 hours ago    1
  ------------------------------------------------- -------------- --------------- -------------

During this assessment, the pending task queue spiked to 9,272 tasks
with the longest queue wait at 136 seconds. The cluster briefly went
YELLOW with 1 unassigned primary shard and 9 initializing shards. This
indicates the master nodes are overwhelmed by the cluster state updates
required to manage 52K shards across 46,910 indices.

Performance metrics (last 24h): Search rate peaks at \~6K/sec with
latency spikes to 600ms (primarily cold/frozen). Indexing rate peaks at
\~6M/sec with sub-millisecond latency. CPU usage: hot 47%, cold 70%,
frozen 54%.

3\. ILM Policy Landscape

79 ILM policies are configured. The critical finding is that the two
largest policies by index count have fundamentally different structures,
and one has a severe defect:

3.1 Core Policies

  ----------------------------- ------------- -------------- ---------- ------------ ----------------------- --------------
  **Policy**                    **Indices**   **Hot Roll**   **Cold**   **Frozen**   **Delete**              **Retain**
  **basic-lifecycle-metrics**   **36,222**    3d / 50GB      3d         7d           **NONE --- MISSING!**   **INFINITE**
  basic-lifecycle-logs          10,809        1d / 50GB      1d         7d           90d                     90d
  us-default-logs-prod          546           24h / 50GB     1d         7d           90d                     90d
  us-default-traces-prod        336           24h / 50GB     1d         7d           90d                     90d
  us-default-logs-nonprod       149           24h / 50GB     1d         3d           30d                     30d
  us-default-metrics-prod       ---           24h / 50GB     1d         7d           90d                     90d
  us-default-traces-nonprod     ---           24h / 50GB     1d         3d           30d                     30d
  us-default-metrics-nonprod    ---           24h / 50GB     1d         3d           30d                     30d
  ----------------------------- ------------- -------------- ---------- ------------ ----------------------- --------------

3.2 APM Policies (18 total --- all hot-only)

  -------------------------------- ----------- --------------- -------------- ----------------------
  **Policy Group**                 **Count**   **Retention**   **Phases**     **Issue**
  APM app logs / error logs        2           10d             hot → delete   No tier transitions
  APM traces / RUM traces          2           10d / 90d       hot → delete   No tier transitions
  APM app/internal metrics         2           90d             hot → delete   90d on hot only
  APM 1m aggregations (4 types)    4           90d             hot → delete   90d on hot only
  APM 10m aggregations (4 types)   4           180d            hot → delete   180d on hot only
  APM 60m aggregations (4 types)   4           **390d**        hot → delete   **390 DAYS on hot!**
  -------------------------------- ----------- --------------- -------------- ----------------------

3.3 Synthetics Policies (hot-only, 365-day retention)

6 synthetics policies keep data on hot storage for up to 365 days with
30-day rollover. Browser/HTTP/ICMP/TCP monitors retain for a full year
on the most expensive tier. Browser network and screenshot data retains
for 14 days. Combined these cover \~259 indices---not massive but
wasteful of hot-tier capacity.

4\. Key Findings & Optimization Opportunities

4.1 basic-lifecycle-metrics Has NO Delete Phase (CRITICAL)

**This is the single most impactful finding across all three clusters.
The basic-lifecycle-metrics policy governs 36,222 indices (77% of all
indices on the cluster) and 427 data streams, including the two largest
data producers: Windows service metrics (57.4B docs) and Windows perfmon
metrics (34.8B docs). The policy moves data from hot (3d) → cold (3d) →
frozen (7d)... and then keeps it forever.**

There is no delete phase. Data is never cleaned up. This is the root
cause of the 140.63 TB frozen-tier footprint. The oldest indices in the
pattern date back to late 2024 (the cluster creation date of October
2024), meaning over 16 months of metrics data is accumulating
indefinitely.

For comparison, the basic-lifecycle-logs policy (10,809 indices) does
have a 90-day delete phase. The metrics policy simply has this phase
missing---likely an oversight when the policy was created or last
modified (September 2025, version 11).

Recommendation: Add a delete phase to basic-lifecycle-metrics with
appropriate retention (90d to match logs, or 30--60d to match eu-b2b
optimized baselines). Adding a 90-day delete would immediately begin
aging out 12+ months of accumulated frozen data. Conservative estimate:
this could free 80--100+ TB of frozen S3 storage over the following 90
days as old data expires.

4.2 52K Shards --- Master Node Overload (CRITICAL)

The cluster has 48,675 primary shards (51,672 total). This is far above
the recommended ratio of \~1,000 shards per GB of master node heap. With
8 GB RAM per master node (\~4 GB heap), the recommended maximum is
\~4,000‒6,000 shards---the cluster is at 8--10x this limit.

This is the root cause of the 9,272 pending task spike, the circuit
breaker trips on 11 nodes, and the coordinating node instability. Every
cluster state update (shard allocation, ILM transitions, index creation)
must be serialized across a state containing 52K shard entries. The
master nodes are 8 GB each---too small for this shard count.

Recommendation: The shard count must be reduced aggressively through:
(a) Adding a delete phase to basic-lifecycle-metrics (eliminates 36K+
frozen-tier shards over time). (b) Reducing hot rollover from 50 GB to 2
GB + adding warm-phase shrink-to-1 (reduces active shard count per
index). (c) Force-merging frozen searchable snapshots where possible.
The delete phase fix alone will begin reducing the shard count within
days as old frozen indices are cleaned up.

4.3 No Warm Phase Used --- 0 GB Warm Tier (COST OPPORTUNITY)

The warm tier is allocated (max 380 GB/zone, 2 GB RAM) but currently at
0 MB utilization. No ILM policy routes data through warm. All data goes
directly from hot → cold → frozen, bypassing warm entirely.

None of the core policies include warm-phase actions (shrink,
force-merge, replica reduction). This means: indices are never shrunk to
1 shard (contributing to the 52K shard count), indices are never
force-merged (wasting segment overhead), and replicas are never reduced
to 0 before cold (cold stores full replicas).

Recommendation: Add warm phase with shrink-to-1,
force-merge-to-1-segment, and 0-replicas to all core policies. This is
the same structural optimization applied to eu-b2b and planned for
eu-cld.

4.4 Cold-Tier Replica Waste (HIGH IMPACT)

Cold-phase indices carry full replicas because no policy configures
replica reduction. With 4.45 TB of cold storage, approximately half
(\~2.2 TB) is replica waste. Cold node \#170 at 69% and JVM at 77%/87%
(AutoOps) would benefit significantly from replica elimination.

Recommendation: Add allocate.number\_of\_replicas: 0 to the cold phase
of all policies. This halves cold storage, bringing \#170 from 69% to
\~35% and resolving the JVM memory pressure.

4.5 APM Policies --- All Hot-Only, 390-Day Maximum (HIGH IMPACT)

All 18 APM policies use only hot → delete with no warm/cold/frozen
phases. The 60-minute aggregation metrics (4 policies) retain for 390
days---over a year on hot storage. The 10-minute aggregations retain for
180 days on hot. Even the app/internal metrics stay on hot for 90 days.

Recommendation: Add warm/cold/frozen phases to all APM policies. The
390-day 60m aggregation data should move to frozen by day 14 at the
latest. This is identical to the eu-cld implementation plan.

4.6 Synthetics Policies --- 365 Days Hot-Only (MEDIUM)

6 synthetics policies retain browser, HTTP, ICMP, and TCP monitoring
data for 365 days on hot storage with 30-day rollover cycles. \~259
indices across these policies.

Recommendation: Add cold/frozen phases. Synthetics data older than 7
days rarely needs fast access.

4.7 50 GB Rollover Threshold (HIGH IMPACT)

All core policies use max\_primary\_shard\_size: 50 GB. This creates
oversized shards that are slow to relocate, hard to rebalance, and
consume disproportionate hot-tier space. Eu-b2b standardized to 2 GB.

Recommendation: Reduce to 2 GB across all policies. Combined with
warm-phase shrink-to-1, this dramatically reduces the active shard count
while improving shard balance across hot nodes.

4.8 Metricbeat Stuck Indices (LOW)

Metricbeat 9.0.0 data stream has an index
(.ds-metricbeat-9.0.0-2025.03.01-000002) stuck in hot:rollover since
March 2025---over 12 months. The metricbeat policy is hot-only with no
delete phase. This should be force-rolled over and the policy updated.

4.9 Pending Task Storm & Circuit Breaker Trips (SYMPTOM)

During assessment, the cluster had 9,272 pending tasks with 136-second
queue wait. Circuit breakers tripped on 11 nodes. These are symptoms of
the 52K shard count overwhelming the 8 GB master nodes. Resolving the
shard count (findings 4.1, 4.2, 4.3) will resolve these symptoms.

5\. Recommended Actions

5.1 Immediate --- Structural Optimizations

  -------- --------------------------------------------------------- -------------- ------------ ---------- -----------------------------------------
  **\#**   **Action**                                                **Impact**     **Effort**   **Risk**   **Addresses**
  **1**    **Add delete phase to basic-lifecycle-metrics (90d)**     **CRITICAL**   Low          Low        140 TB frozen, 36K indices, shard count
  2        Add warm phase (shrink/merge/0-replica) to all policies   Very High      Low          Low        Shard count, cold capacity
  3        Add cold-phase 0-replicas to all policies                 High           Low          Low        Cold \~50% freed
  4        Reduce hot rollover from 50 GB to 2 GB                    High           Low          Low        Hot imbalance, shard size
  5        Add warm/cold/frozen to APM policies                      High           Low          Low        Hot capacity (390d!)
  6        Add cold/frozen to synthetics policies                    Medium         Low          Low        365d hot-only waste
  7        Force-rollover stuck metricbeat indices                   Low            Low          Low        Cluster hygiene
  8        Investigate unhealthy coord/Kibana nodes                  Medium         Low          Low        Cluster stability
  9        Address 6 template optimization alerts                    Medium         Medium       Low        Shard count
  -------- --------------------------------------------------------- -------------- ------------ ---------- -----------------------------------------

5.2 Deferred --- Retention Review

Once structural optimizations are validated (4--6 weeks
post-implementation), conduct a separate retention review with
stakeholders to align retention periods to actual data value. The eu-b2b
baseline (30d logs, 45d infra-logs, 60d traces/metrics) provides the
reference point.

Why the Warm Phase Is Essential

*The warm phase is a processing step, not just a storage tier. It is the
mechanism that delivers the shard count reduction, search performance
improvements, and storage savings that no other phase can provide.*

What the Warm Phase Does (eu-b2b Standard)

On eu-b2b, every ILM policy includes a warm phase at 1 day
post-rollover. The warm phase performs three operations that are
critical for cluster health and cost efficiency:

**1. Shrink to 1 shard --- This is the most important action. When an
index rolls over on hot at 2 GB, it may have multiple primary shards
(auto-split by the index template). The warm-phase shrink consolidates
all shards into one. Over thousands of indices, this is how the shard
count drops dramatically. On eu-b2b this keeps the cluster at \~1,878
indices with a manageable shard count, versus the tens of thousands seen
on clusters without shrink. Shrink cannot be performed in the cold phase
--- Elasticsearch requires the source index to be on warm or hot nodes;
cold nodes do not support it.**

**2. Force-merge to 1 segment --- Each shard internally consists of
multiple Lucene segments created during indexing. Force-merging combines
them into a single optimised segment. This reduces disk I/O, improves
search performance on historical data, and eliminates ongoing background
merge overhead. This is a CPU-intensive operation suited to warm nodes
--- cold nodes have limited CPU and are designed for storage, not
processing.**

**3. Replicas to 0 --- Once data is read-only (no longer being written
to), replica shards are unnecessary for resilience because the data is
about to move to cold/frozen where snapshots provide durability.
Dropping replicas halves the storage footprint before data reaches cold.
Without this, cold-tier indices carry full replicas, doubling cold
storage consumption.**

Why These Actions Cannot Be Deferred to Cold

Shrink and force-merge are CPU/IO-intensive operations that require
reasonable compute resources. Cold nodes on this cluster are low-RAM,
storage-optimised hardware (aws.es.datacold.d3) designed for holding
data cheaply, not processing it. Running shrink or force-merge on cold
nodes would degrade cold-tier performance and could trigger circuit
breaker trips. The warm phase exists specifically as a "processing
station" between active hot and archival cold.

Replica reduction to 0 can technically be set in cold (and is, as a
belt-and-braces confirmation), but the storage savings are realised
earlier when replicas are dropped in warm before data moves to cold.

What eu-b2b Proves

On eu-b2b, the warm tier (2 nodes, 4 GB RAM each, 760 GB storage) sits
at just 9% utilisation (130 GB). Data only resides there for
approximately 1 day (warm at 1d, cold at 2d). It acts as a throughput
gateway: indices enter, get shrunk, merged, and de-replicated, then move
on to cold in an optimised state. The result is that eu-b2b runs with
only 1,878 indices and a manageable shard count --- clean, efficient,
and stable.

Infrastructure Cost

On this cluster, the warm tier hardware is already provisioned (or
allocated) but sitting idle because no ILM policy routes data through
it. Adding the warm ILM phase costs nothing in infrastructure --- the
capacity is already paid for. The warm phase simply activates the
processing pipeline that makes every subsequent tier (cold, frozen) more
efficient.

6\. Estimated Cost & Storage Impact

Savings are split into structural optimizations (immediate) and the
indefinite-retention fix (also immediate but with delayed realization as
old data expires).

6.1 Phase A: Structural + Delete Phase Fix

  ----------------- ------------- --------------------- -------------------- --------------------------------------------------------
  **Tier**          **Current**   **Projected (90d)**   **Freed**            **Mechanism**
  **Frozen (S3)**   140.63 TB     **\~40--60 TB**       **80--100 TB**       Delete phase removes 12+ months of accumulated metrics
  Cold              4.45 TB       \~2.2 TB              \~2.2 TB             0-replicas eliminates duplicates
  Hot               2.64 TB       \~1.5--2 TB           \~0.5--1 TB          APM/synthetics tier transitions, 2GB rollover
  Warm              0 GB          \~50--200 GB          +50--200 GB          Now actively processing data
  **Shards**        **51,672**    **\~15K--25K**        **25K--35K fewer**   **Delete phase + shrink + smaller rollover**
  ----------------- ------------- --------------------- -------------------- --------------------------------------------------------

The shard reduction from 52K to \~15--25K will resolve the pending task
storms, circuit breaker trips, and coordinating node instability. This
is the most impactful change across all three clusters.

6.2 Estimated Monthly Savings

  ---------------------------------- --------------------------------------- ----------------------------
  **Phase**                          **Storage Impact**                      **Monthly Savings**
  **A: Delete phase + structural**   \~85--100 TB freed (primarily frozen)   **\$3,000--\$5,000/month**
  B: Retention review (deferred)     \~10--20 TB additional frozen           \$500--\$1,500/month
  **Combined total**                 **\~95--120 TB freed**                  **\$3,500--\$6,500/month**
  ---------------------------------- --------------------------------------- ----------------------------

The combined potential represents a 26--48% reduction on the current
\$13,450/month spend. The delete-phase fix alone (finding 4.1) is
responsible for the majority of the savings.

7\. Comparison Across Clusters

  -------------------------- ------------------------ ---------------------- -------------------------------------
  **Dimension**              **eu-b2b (optimized)**   **eu-cld (planned)**   **us-cld (current)**
  Status                     GREEN                    GREEN                  GREEN (ES) / UNHEALTHY (Cloud)
  Nodes                      17                       19                     17
  Indices                    \~8,000                  \~7,900                46,910
  Shards                     \~10K                    \~10.8K                51,672
  ILM policies               \~83                     72                     79
  Hot rollover               2 GB                     50 GB → 2 GB           50 GB → 2 GB (planned)
  Warm shrink/merge          Yes                      Not configured → Yes   Not configured → Yes (planned)
  Cold replicas              0                        Inherits → 0           Inherits → 0 (planned)
  **Metrics delete phase**   **Yes (30--60d)**        **Yes (90d)**          **MISSING --- infinite retention!**
  Frozen storage             \~1 TB                   70.31 TB               140.63 TB
  Hourly rate                \$7.67                   \$31.12                \$18.45
  Monthly cost               \~\$5,600                \~\$22,650             \~\$13,450
  -------------------------- ------------------------ ---------------------- -------------------------------------

Appendix: Full ILM Policy Inventory

*79 policies total. Sorted by index count descending. Key custom
policies shown with full phase details.*

  ----------------------------- ------------- ------------------------------------------ ------------ ------------------------
  **Policy**                    **Indices**   **Phases**                                 **Delete**   **Issue**
  **basic-lifecycle-metrics**   **36,222**    hot(3d)→cold(3d)→frozen(7d)                **NONE**     Infinite retention!
  basic-lifecycle-logs          10,809        hot(1d)→cold(1d)→frozen(7d)→delete(90d)    90d          ---
  us-default-logs-prod          546           hot(24h)→cold(1d)→frozen(7d)→delete(90d)   90d          50GB rollover
  us-default-traces-prod        336           hot(24h)→cold(1d)→frozen(7d)→delete(90d)   90d          50GB rollover
  us-default-logs-nonprod       149           hot(24h)→cold(1d)→frozen(3d)→delete(30d)   30d          50GB rollover
  .alerts-ilm-policy            99            hot only                                   ---          Alert indices
  synthetics browser            51            hot(30d)→delete(365d)                      365d         365d hot-only
  synthetics HTTP               33            hot(30d)→delete(365d)                      365d         365d hot-only
  synthetics ICMP/TCP           54            hot(30d)→delete(365d)                      365d         365d hot-only
  APM traces                    4             hot→delete(10d)                            10d          No tier transitions
  APM 60m metrics (x4)          ---           hot→delete(390d)                           390d         390d hot-only!
  APM 10m metrics (x4)          ---           hot→delete(180d)                           180d         180d hot-only
  APM 1m metrics (x4)           ---           hot→delete(90d)                            90d          Hot-only
  metricbeat                    2             hot only                                   NONE         No delete, stuck index
  \+ 47 built-in/fleet/system   \~110         Various                                    Various      Standard defaults
  ----------------------------- ------------- ------------------------------------------ ------------ ------------------------

*Report generated from live cluster data (Elasticsearch MCP tools) and
Elastic Cloud console screenshots on 10 March 2026.*
