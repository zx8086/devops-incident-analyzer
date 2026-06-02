**eu-b2b Wide Cost Sweep**

*Cluster-wide cost-saving review · 2026-05-14 · post warm-resize + 9.4.1
+ 16 ILM edits*

**0. Scope and context**

This is a wide cost-saving review of eu-b2b run after the 2026-05-14
change package (warm-tier resize, 9.4.0→9.4.1 upgrade, 16 ILM policy
edits) landed and was validated. It covers four areas: shard & index
hygiene, node topology, snapshots & ingest pipelines, and ingestion
volume. The ILM / retention / tiering angle is already covered by the
prior spec, runbook and implementation record --- this sweep
deliberately looks elsewhere.

*All figures are from live cluster APIs (cluster\_stats, nodes\_stats,
indices\_summary, get\_shards, ilm) pulled 2026-05-14. The Elastic Cloud
plan API remains 403 --- node sizing here is read from nodes\_stats
os.mem.total\_in\_bytes (node RAM) and jvm.mem.heap\_max\_in\_bytes
(heap), which is reliable.*

**1. Node topology**

15 nodes total --- 8 data, 3 master, 2 coordinating/ingest, 2 ML. RAM is
read from os.mem.total\_in\_bytes; heap is typically half of node RAM on
Elastic Cloud.

  ----------------------- --------------- ---------------- ------------------- -----------------------------------------------------------------------------------------------------
  **Tier / role**         **Nodes**       **RAM / heap**   **Disk used**       **Observation**
  Hot / content           095, 106, 150   \~16 GB / 8 GB   28--39% of 450 GB   Headroom, but register\'s \'21% downsizable\' figure is stale --- re-baseline after ILM convergence
  Warm                    154, 155        8 GB / 4 GB      7% of 1520 GB       Just resized; over-provisioned on disk (d3 RAM:disk bundling) --- side effect, not actionable alone
  Cold                    122, 141        2 GB / 1 GB      62% of 380 GB       Pressured; at the aws.es.datacold.d3 2 GB instance floor --- cannot downsize
  Frozen                  147             30 GB / 15 GB    95% of 2220 GB      LRU cache, expected to run full; not a cost issue per existing playbook note
  Master                  072, 074, 087   4 GB / 2 GB      0% of 48 GB         Appropriate
  Coordinating / ingest   098, 140        16 GB / 7.5 GB   0% of 120 GB        RECENTLY INCREASED --- correctly sized, NOT a downsize candidate (see 1.1)
  ML                      152, 153        4 GB / 2 GB      0% of 48 GB         Utilisation unverified --- candidate for removal if idle, verify ML jobs first
  ----------------------- --------------- ---------------- ------------------- -----------------------------------------------------------------------------------------------------

**1.1 Coordinating/ingest tier --- correctly sized, NOT a downsize
candidate**

**Correction:** an earlier draft of this sweep recommended downsizing
the coordinating/ingest tier \"8 GB → 4 GB\". That recommendation was
wrong and has been withdrawn. It conflated the heap size with the node
size and drew a false parallel to us-cld.

instance-098 and instance-140 are aws.es.coordinating.m5d nodes at 16 GB
RAM / 7.5 GB heap each --- not 8 GB. They were recently increased: 16 GB
RAM is double the us-cld coordinating default, and the May 8 incident
log records \"coordinating loaded\" AutoOps alerts. The size-up was a
deliberate response to coordinating-tier load during that incident.

Live heap at the time of this sweep: instance-098 at 58% (4.36 GB used
of 7.5 GB heap), instance-140 at 32% (2.42 GB used). Old-gen is low on
both (\~370--380 MB), GC is healthy (0 old collections), 0 breaker
trips. instance-098 alone uses 4.36 GB of heap --- more than the entire
heap of an 8 GB RAM node. Downsizing would re-trigger the exact pressure
the increase resolved.

**Why the original reasoning was flawed:** the basis was \"0% disk,
stores no data\". Coordinating nodes do not store data by design ---
their heap is sized for request coordination (search/aggregation
fan-out, ingest pipeline processing), not storage. Disk utilisation is
irrelevant to coordinating-node heap sizing. The us-cld parallel does
not apply either: us-cld\'s coordinating nodes were 8 GB RAM with low
request volume; eu-b2b\'s are 16 GB and were sized up because they were
loaded.

**Disposition:** no coordinating-tier cost saving. The tier is correctly
sized. Leave as-is.

**1.2 ML nodes 152 / 153 --- verified dormant, removable pending
security-team signoff**

Two ML nodes (instance-152, instance-153) at 4 GB RAM / 2 GB heap each,
0% disk. ML inventory done 2026-05-14:

-   .ml-config holds 50 documents --- 25 anomaly-detection jobs + 25
    datafeeds, all Elastic Security prebuilt SIEM jobs
    (v3\_linux\_anomalous\_\*, auth\_rare\_user,
    suspicious\_login\_activity, high\_count\_network\_\*, etc.).

-   No anomaly results: .ml-anomalies-\* has 0 bucket result documents
    ever, and 0 in the last 7 days. The 146 docs it does hold are
    model\_snapshot / model\_size\_stats entries, all timestamped
    2024-08-15 --- the jobs were installed in the August 2024 Security
    setup batch (same batch as the SLOs from the May 8 incident) and
    have not run since.

-   No DEPLOYED models: ELSER 2 model artifacts are present on disk
    (.ml-inference-native-000002, 264 docs / 698 MB, all
    .elser\_model\_2\_linux-x86\_64) but ELSER is
    downloaded-not-deployed --- it has no trained-model config in
    .ml-config and no inference endpoint in .inference-\*. The 8
    endpoints in .inference-\* are the ES 9.x preconfigured defaults
    (OpenAI, Gemini, Jina, e5); the third-party ones run on the
    provider's infrastructure, not the ML nodes. A
    downloaded-but-undeployed model does not pin an ML node.

-   ML nodes carry only baseline JVM: instance-152 at 15% heap,
    instance-153 at 44% heap of a 2 GB heap --- no job models loaded.

Storage footprint of the ML index family: \~730 MB total, of which 698
MB (96%) is the dormant ELSER 2 artifact index. The 50 .ml-config
job/datafeed configs are 192 KB --- negligible. The 146 .ml-anomalies-\*
docs are a few MB across \~25 small indices. The 698 MB of ELSER
artifacts is reclaimable disk if ELSER is confirmed unwanted (delete the
trained model; .ml-inference-native clears) --- \~0.06% of the 1.23 TB
cluster primary store, so it is hygiene, not a cost lever.

**Verdict:** the ML tier carries no live workload and is removable from
a platform standpoint. Estimated saving \~€1--2K/yr (2 × 4 GB RAM
nodes).

**Gate before removal:** this is a security-team and search-owner
decision, not a pure platform call. Before zeroing the ML tier: (1)
security team confirms they do not intend to use SIEM anomaly detection
on eu-b2b; (2) check for Security detection rules of type
machine\_learning that reference these job IDs --- those rules are
already silently not firing, but removal makes it permanent; (3) confirm
whether the 7 indices with semantic\_text fields are still in use and
whether anyone intends to deploy ELSER or an Elastic-hosted embedding
model again --- semantic\_text queries run inference at search time and
need an ML node; nothing is deployed now, but the field definitions and
7,681 sparse\_vector values show semantic search was set up at some
point; (4) optionally delete the 25 job + 25 datafeed configs and the
dormant ELSER artifacts so nothing orphaned is left behind. Closed jobs
and undeployed models do not need an ML node, so zeroing the tier works
without deleting anything --- but orphans invite confusion.

**Note vs us-cld:** the register\'s us-cld ML-removal line (table 5 r36)
was withdrawn after live verification found APM transaction-metric ML
workload there. eu-b2b is genuinely different --- verified: only dormant
Security prebuilts, no APM ML jobs.

**1.3 Hot tier --- re-baseline, do not action on the stale figure**

Issue Register table 5 r10 says the hot tier is at \"21% utilisation, 3
nodes downsizable\". Live hot disk is now 28--39% --- trace volume grew
since that entry. **Re-measure hot disk and JVM around Day 11, after the
2026-05-14 retention cuts + frozen-phase add converge, then decide.
Acting on the stale 21% figure now would be unsafe.**

**2. Shard & index hygiene**

Cluster carries \~1,772 indices and 2,926 shards (cluster\_stats). 6.1
billion docs, \~1.23 TB primary store. Findings:

**2.1 profiling-events --- 11 empty indices**

Universal Profiling was uninstalled and its data streams cleaned on 13
April (Issue Register table 6 r5). 11 profiling-events-\* backing
indices at 0 docs were missed and remain. Delete them --- frees \~11
shards, same low-risk pattern as the 13 April cleanup.

**2.2 252 indices on Elasticsearch 8.x**

cluster\_stats shows index-version spread from 8.12 to 9.4.1. 252
indices still sit on 8.x bodies (8.12: 108, 8.13: 63, 8.14: 13, 8.15:
24, 8.16: 12, 8.17: 27, 8.18: 5) --- mostly small (\<500 MB each). They
carry segment overhead disproportionate to their size. Force-merge or
reindex as a hygiene pass; pair with the 54 empty 2025 backing indices
already on the register (table 6 r8).

**2.3 traces-apm-default remains the dominant dataset**

The traces-apm-default data stream is by far the largest: \~1.32 billion
docs in 16 hot indices plus \~975 million in 10 frozen (partial-)
indices, with 30--36 GB shards. The pvh-services-styles-v3 trace
explosion (Issue Register table 2 r8) is the upstream driver, already
tracked as a P1 app-team item. The 2026-05-14 retention cut from 45d to
30d is already converging this stream down --- no new action, but it
confirms the cut was well targeted.

**3. Ingest pipelines**

eu-b2b runs 939 ingest pipelines (cluster\_stats) --- more than double
eu-cld\'s 416, and eu-cld already has a pipeline-cleanup item on the
register. Processor stats show a \~10% grok failure rate (606 failed of
6,086) and \~1.3% rename failures (15,367 of 1,164,995). Two issues
bundled: master-state bloat from pipeline count, and wasted ingest
cycles from failing patterns. Recommend scoping a pipeline audit.
Indirect saving (master-tier headroom, ingest efficiency) rather than a
direct line-item.

**4. Snapshots**

The found-snapshots S3 repository is healthy --- 0 current snapshot
operations, 0 failures at the time of the sweep. SLM retention policy
detail was not retrievable through the available cluster APIs in this
pass; an SLM retention audit (matching the org-level snapshot-retention
item already on the optimisation tracker, Phase 5) would be the next
step if snapshot storage cost is a concern. Flagged, not quantified.

**5. Summary of opportunities**

  ------------------------------------- ----------------------- ---------- ------------------ ----------------------------------------
  **Opportunity**                       **Est. saving / yr**    **Risk**   **Status**         **Verify first?**
  ML nodes 152/153 removal              €1--2K                  Low--Med   Verified dormant   Security-team signoff + config cleanup
  Delete 11 profiling-events indices    Negligible € (shards)   Low        Proposed           No --- ready
  Ingest pipeline audit & prune         Indirect                Low        Proposed           Scope the pass
  Force-merge/reindex 252 8.x indices   Low direct €            Low        Proposed           No --- hygiene
  Hot tier downsize                     TBD                     Med        Re-baseline        Yes --- re-measure Day 11
  Coordinating tier downsize            --- none                ---        Withdrawn          Correctly sized; recently increased
  Cold tier downsize                    --- none                ---        Closed             Blocked at 2 GB instance floor
  ------------------------------------- ----------------------- ---------- ------------------ ----------------------------------------

**Net position:** the only genuine NEW cost lever from this sweep is the
ML-node removal (\~€1--2K/yr). The ML tier is now verified dormant ---
25 Security prebuilt jobs, last active 2024-08-15, no trained models ---
so removal is real, gated on security-team signoff rather than further
investigation. The coordinating-tier downsize floated in the first draft
has been withdrawn --- those nodes are correctly sized at 16 GB RAM and
were recently increased. The hot-tier downsize could be larger but is
re-baseline-pending. Everything else is hygiene with indirect benefit.
This sweep does not, on its own, surface a large committed saving ---
the real cost movement on eu-b2b remains the ILM retention work already
applied and the app-team ingestion items already tracked.

**6. What this sweep did not cover**

-   ILM retention / tiering --- already covered by the 2026-05-14 change
    package and its spec/runbook/validation docs.

-   App-team ingestion reduction (pvh-services-styles-v3,
    notifications\_scheduler, prices\_producer\_v2) --- already tracked
    as P1/P2 app-team items; blocked on app teams, not platform.

-   SLM snapshot retention detail --- flagged in §4, not quantified;
    needs SLM policy read.

-   Elastic Cloud plan-level attributes --- plan API returns 403 (known
    issue).

*Findings recorded in:
Elastic\_Optimisation\_Tracker\_May14\_2026\_v7.xlsx (PHASE 4.7 block)
and Consolidated\_Issue\_Register\_v12\_May14\_2026.docx (new rows
across tables 3, 5, 6).*

*End of sweep.*
