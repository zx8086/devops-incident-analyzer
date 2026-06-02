**eu-cld Remaining Cost & Memory Levers**

*Cluster eu-cld (eda974) · 5 May 2026 · Catalogue of optimisation work
beyond what landed today, ranked by impact-vs-effort*

**0. Where We Stand**

The work landed today (Phase 2A ILM tightening on 11 policies, Phase 1B
template repointing of 4 templates, kubernetes.state inventory)
addresses the rollover storm --- the single biggest contributor to shard
count. The two follow-up designs (max\_shards\_per\_node ladder,
kubernetes.state consolidation) close out Phases 4 and the AutoOps
shard-count violations.

That is the floor of what\'s possible --- not the ceiling. The catalogue
below lists 12 additional levers the current cluster data points to.
Each entry includes the live signal that surfaced it, expected impact,
effort, and risk.

**1. Tier-1 Levers --- Significant impact, do these next**

**1.1 Mapping field optimisation (Phase 3 --- already on the board)**

Live signal: 4,717,913 total fields across the cluster, deduplicated to
1,223,384 --- meaning roughly 3.5 million field definitions are
duplicated across indices. The breakdown:

  ------------------- ----------- ---------------------- ------------------------------------------------------------------------------------------------------------------------------------------------
  **Field type**      **Count**   **Indices using it**   **Optimisation**
  keyword             2,342,656   26,238                 Drop \*.keyword sub-fields where text fields are not aggregated. Switch high-cardinality keywords to constant\_keyword if value is per-stream.
  object              963,742     26,267                 Mostly structural. Some can be flattened via flattened type.
  long                536,545     25,341                 Switch to scaled\_float for fixed-precision metrics (e.g. percentages, rates). Use byte/short where range allows.
  match\_only\_text   168,736     24,438                 Already using the cheap variant for many text fields --- good.
  text                59,985      2,122                  Convert to match\_only\_text where positional queries are not needed (\~3x cheaper).
  alias               129,164     3,969                  Aliases are free per-index but inflate cluster state. Audit for unused.
  constant\_keyword   101,061     26,013                 Already deployed --- gives near-zero per-doc storage.
  wildcard            25,473      8,326                  Verify wildcard is needed --- much more expensive than keyword if exact-match queries dominate.
  ------------------- ----------- ---------------------- ------------------------------------------------------------------------------------------------------------------------------------------------

Expected impact: 30--50% reduction in mapping memory (currently 12.7 MB
deduplicated mapping size held in cluster state), proportional reduction
in master node JVM pressure. Effort: scoped per-template work, \~2
sessions. Risk: medium --- mapping changes only apply on next rollover,
but require dashboard/query re-validation.

Action: run AutoOps Template Optimizer on the 29 flagged templates first
--- those are the worst offenders. Then sweep remaining templates for
unused \*.keyword sub-fields.

**1.2 Ingest pipeline cleanup --- large CPU waste**

Live signal: 416 ingest pipelines registered. Processor failure rates
show heavy waste:

  --------------- ----------------- ------------ ------------------ -------------------------
  **Processor**   **Total calls**   **Failed**   **Failure rate**   **Time spent**
  grok            59,350,856        22,095,232   **37%**            808s
  lowercase       28,678,258        19,847,506   **69%**            114s
  convert         97,039,283        11,947,917   12%                87s
  enrich          9,355,326         7,246        0.08%              **66,244s (18 hours!)**
  script          165,274,070       528,388      0.3%               622s
  dissect         7,616,787         919,092      12%                40s
  --------------- ----------------- ------------ ------------------ -------------------------

Two distinct issues here:

-   \*\*Failure rates of 37--69%\*\* on grok and lowercase mean those
    processors are hitting documents they were never meant to handle, or
    the patterns are wrong. Each failed call still costs CPU. Options:
    tighten the if-clauses on the processors, fix the patterns, or drop
    the processor entirely if it\'s vestigial.

-   \*\*Enrich processor consumed 18 hours of CPU\*\* for 9.3M calls ---
    an average of 7ms per call. For low-cardinality enrichments this
    should be sub-millisecond. Investigate which enrich policies are
    slow (likely large reference indices not held in memory). Consider
    switching to runtime fields or denormalising at write time.

Expected impact: 20--40% reduction in ingest CPU on the 3 ingest nodes
(currently 153% combined CPU per cluster\_stats). Could enable
downsizing the ingest tier from 3 to 2 nodes. Effort: medium, requires
per-pipeline review. Risk: low --- pipeline changes are reversible
per-pipeline.

**1.3 Replicate today\'s fixes to ap-cld and us-cld**

Live signal: CCS metadata shows eu-cld federates with eu-b2b, ap-cld,
us-cld. The same patterns that produced this cluster\'s shard sprawl
(empty retention-fleet templates, daily ILM rollover, kubernetes.state
per-namespace streams) almost certainly exist on ap-cld and us-cld ---
the integration packages and PVH naming conventions are uniform.

Expected impact: equivalent shard reduction on each cluster (\~50%
steady state). For the federation as a whole, this is the
highest-multiplier work --- same playbook applied 3x. Effort: \~1
session per cluster (validation + apply). Risk: low --- same change,
same reversal.

Action sequence: take the eu-cld AutoOps Session Changes document as the
runbook; check each cluster\'s policies and templates first; apply the
same ILM updates and template fixes; record the deltas in per-cluster
session change docs.

**1.4 Force-switch existing dev/stg backing indices to nonprod ILM**

Live signal: 968 backing indices currently match dev/stg/test/nonprod
patterns but were created before today\'s template fix, so they remain
on the prod 90-day ILM. They will age out naturally over 90 days, but a
one-shot settings update accelerates this to 30 days.

\# For each affected data stream

PUT \<data-stream\>/\_settings

{

\"index.lifecycle.name\": \"eu-default-lifecycle-logs-nonprod\"

}

Expected impact: 600+ indices deleted within 30 days instead of 90.
Frozen tier shard count drops faster, accelerating
max\_shards\_per\_node ladder by \~4 weeks. Effort: low --- wildcard
apply per data stream type. Risk: medium --- some existing dev/stg
indices \>30 days old would be deleted within \~3 days. Needs explicit
owner approval; defer to \~Day 7 of the new ILM observation window.

**2. Tier-2 Levers --- Material impact, medium effort**

**2.1 Synthetic source mode expansion**

Live signal: cluster has 13,042 stored-source indices and 13,256
synthetic-source indices. Synthetic source rebuilds \_source from
doc\_values on demand, saving 30--50% of disk for compatible field types
(numeric, keyword, ip, geo, date). The metrics tier is the obvious
target --- most metric data is purely numeric/keyword and is rarely
retrieved as full \_source.

Expected impact: \~30% reduction in storage on metrics indices that
migrate (the heavy hitters: kubernetes.\* metrics, system.\* metrics,
otel.\* metrics --- together ≈ 12 TB on disk + S3). Net: 3--4 TB storage
saved, mostly on frozen S3. Effort: per-template change, applied at next
rollover. Risk: low --- synthetic source is a stable feature in 9.x;
rollback is a settings flip.

\# Add to component template, e.g. metrics\@settings or per-dataset
\@custom

\"settings\": {

\"index\": {

\"mapping\": {

\"source\": {

\"mode\": \"synthetic\"

}

}

}

}

**2.2 logsdb mode expansion for log streams**

Live signal: three nonprod templates (logs-gkapps-nonprod,
logs-java-nonprod, logs-plm-nonprod) already use \`mode: logsdb\` with
2x compression. Most other log datasets do not. logsdb provides
automatic synthetic source plus host-name sorting which yields \~50%
compression on top of best\_compression.

Top log volume datasets (last day): kubernetes.container\_logs (691M
docs), apm.rum (575M), gkpos (393M), cisco\_meraki (353M), cisco\_ftd
(347M). Expected impact for these: 30--50% reduction in storage ---
biggest absolute win on frozen S3 cost. Effort: per-template change.
Risk: low --- logsdb is GA in 9.x and behaves correctly with most query
patterns. Some text full-text scoring queries lose precision; verify
against current query mix.

\# Add to log component template

\"settings\": {

\"index\": {

\"mode\": \"logsdb\"

}

}

**2.3 Downsampling for older metrics**

Live signal: APM already runs 1m → 10m → 60m downsampling chains
(visible in ILM list:
metrics-apm.service\_destination\_1m\_metrics-default\_policy etc.).
Most other metric streams do NOT downsample. The largest non-APM metric
streams are:

-   generic.otel: 4.06B docs

-   service\_transaction.10m.otel: 2.22B

-   transaction.10m.otel: 2.22B

-   kubernetes.apiserver: 260M

-   hostmetricsreceiver.otel: 222M

-   kubeletstatsreceiver.otel: 214M

Expected impact: 80--95% reduction in disk for downsampled tiers. Adding
\`downsample\` to the cold or frozen ILM phases for kubernetes.\* and
hostmetrics.\* would yield significant frozen reduction. Effort:
per-policy change. Risk: medium --- downsampling is one-way (resolution
is lost), needs business confirmation that minute/hour-level resolution
is acceptable for \>5d-old metrics.

\# Add to cold or frozen phase of metric ILM policy

\"cold\": {

\"min\_age\": \"5d\",

\"actions\": {

\"downsample\": {

\"fixed\_interval\": \"10m\"

},

\"allocate\": { \"number\_of\_replicas\": 0 }

}

}

**2.4 Stale stream identification and deletion**

Live signal: data stream catalogue includes patterns that are very low
volume in last 24h, suggesting they may be defunct:

-   Some cohesity, citrix, rfsql-warehouse, vsphere streams

-   Old version indices (8.13.x, 8.14.x, 8.15.x) --- 93 indices total,
    11.5 GB primary

-   Tableau-related streams in nonprod

Expected impact: 100--500 shards deleted, plus eliminates the per-day
maintenance cost. Effort: low --- straightforward DELETE per
confirmed-defunct stream. Risk: low if confirmed with data owners; high
if assumed. Action: enumerate streams with zero ingest in the last 30
days, present list to platform/observability for sign-off, then delete.

\# Find candidates

GET \_data\_stream

GET .ds-\*-2025\*/\_search { \"size\": 0, \"track\_total\_hits\": true }

\# Per confirmed-defunct stream

DELETE \_data\_stream/\<stream-name\>

**2.5 Tier downsizing once shard count stabilises**

Live signal: hot tier currently 1,602--1,692 shards/node, 23--41% disk
used. After Phase 2A drives shard count to \~700/node, hot is
over-provisioned. Same for warm (already at 254--258 shards/node, well
below the 1,000 ceiling).

Candidate downsizes (after 30--45 days of observation):

-   Hot tier: c6gd 3 nodes → potentially 2 nodes if shard count holds at
    \~1,000 cluster-wide and write load stays in current band

-   Warm tier: 3 i3en nodes --- already lightly loaded, but cannot
    reduce below 3 due to AZ requirement

-   Master tier: c6gd 3 nodes --- at 84% heap on one node today; will
    drop to \~50% post-stabilisation. Could downsize per-node memory if
    Elastic Cloud allows.

Expected impact: hot tier downsize alone is \~33% reduction in hot tier
cost (one of the more expensive instance types). Effort: trivial in the
Elastic Cloud console. Risk: medium --- must verify under production
load first. Per the saved memory, downsize Current size first then
Maximum (validation requires Max ≥ Current).

**3. Tier-3 Levers --- Smaller or specialised wins**

**3.1 Old version index cleanup**

Live signal: 93 indices on pre-9.x versions (8.13--8.18, total 38 GB
primary). Likely orphaned from past upgrades. Verify and delete or
re-index. Impact: small disk win, removes some master state. Risk: low
if verified.

**3.2 Codec verification on old indices**

Live signal: best\_compression confirmed on the sampled active indices,
but unverified across the long tail. Quick scan to confirm all frozen
indices use best\_compression. Impact: minor on already-frozen data, but
catches any straggler. Effort: one query.

**3.3 Snapshot Lifecycle Management review**

Live signal: cloud-snapshot-policy referenced in the delete action of
every prod ILM policy. Need to verify snapshot retention is aligned with
the data retention. If snapshots persist longer than the data they back
up, that\'s pure S3 cost waste. Effort: review SLM policies; one Kibana
check.

GET \_slm/policy

GET \_snapshot/found-snapshots/\_status

**3.4 Field alias audit**

Live signal: 129,164 alias instances across 3,969 indices --- average 32
aliases per indexed alias. Many may be redundant (legacy ECS migrations,
etc.). Aliases inflate cluster state. Impact: small per-alias, large in
aggregate.

**3.5 ML / Transform usage review**

Live signal: 1 ML node, 70% heap, runs continuously. 3 transform-capable
nodes. If ML jobs and transforms aren\'t actively producing value,
they\'re consuming heap budget. Effort: review GET
\_ml/anomaly\_detectors and GET \_transform; correlate with dashboards.
Impact: potential ML node removal if unused.

**3.6 CCS query caching / pattern review**

Live signal: 1,747 cross-cluster searches in the snapshot window, max
1,559ms latency to eu-b2b, 0ms to ap-cld and us-cld (no actual remote
work --- they\'re configured but not queried). If ap-cld and us-cld
remotes aren\'t used in practice, removing them saves cluster overhead.
Effort: confirm with owners.

**3.7 Index sort optimisation for time-series indices**

Live signal: TSDB awareness present (time\_series.start\_time/end\_time
defaults set), but not all metric indices use TSDB mode. For
TSDB-enabled indices, sorting by host.name/dimension fields can yield
5--10x compression. Worth piloting on the heaviest non-TSDB metric
streams. Effort: per-template change. Risk: low.

**4. Sequencing & Combined Impact**

**4.1 Recommended order**

  -------------------------------- -------------------------------- ------------------------- ------------
  **Lever**                        **Impact estimate**              **Effort**                **When**
  Mapping optimisation (1.1)       30--50% master heap reduction    2 sessions                Week 2
  Pipeline cleanup (1.2)           20--40% ingest CPU reduction     1 session                 Week 2
  Replicate to ap/us-cld (1.3)     Same gains × 2 clusters          1 session each            Weeks 2--3
  Force-switch dev/stg ILM (1.4)   −4 weeks on max\_shards ladder   1 session                 Day 7+
  Synthetic source (2.1)           30% storage on metrics           Per-template              Week 3+
  logsdb expansion (2.2)           30--50% storage on logs          Per-template              Week 3+
  Downsampling (2.3)               80--95% disk on cold metrics     Per-policy                Week 4+
  Stale stream cleanup (2.4)       100--500 shards                  Owner sign-off + delete   Week 2
  Tier downsize (2.5)              20--33% tier cost                Cloud console             Week 4+
  Tier-3 levers (3.x)              Small individual, additive       As-needed                 Ongoing
  -------------------------------- -------------------------------- ------------------------- ------------

**4.2 Combined steady-state impact**

If all Tier-1 and Tier-2 levers land alongside today\'s work and the two
follow-ups, modelled steady-state outcome on eu-cld:

  -------------------------- --------------- ------------------------- -------------------------- -------------
  **Dimension**              **Today**       **After today\'s work**   **After Tier-1+2**         **Total Δ**
  Active shards              28,910          ≈ 14,000                  ≈ 8,000                    −72%
  Frozen S3 storage          67.6 TB         67.6 TB                   ≈ 38 TB                    −44%
  Hot tier disk              1.7 TB          1.7 TB                    ≈ 1.0 TB                   −41%
  Master JVM heap pressure   84% peak        ≈ 50%                     ≈ 30%                      −64%
  Mapping memory             12.7 MB         12.7 MB                   ≈ 7 MB                     −45%
  Ingest CPU                 153% combined   150%                      ≈ 100%                     −35%
  AutoOps open events        6               ≈ 2                       0                          all clear
  Tier sizing options        all locked      hot downsizable           hot + master downsizable   ongoing
  -------------------------- --------------- ------------------------- -------------------------- -------------

**4.3 What still cannot be done from this cluster**

-   \`cluster.max\_shards\_per\_node\` query and modification --- Kibana
    Dev Tools required (the connected Elasticsearch tooling does not
    expose \`\_cluster/settings\`).

-   Tier sizing changes --- Elastic Cloud console action.

-   Snapshot Lifecycle Management policy modifications --- possible via
    Kibana but typically managed by the platform team.

-   Agent policy / Fleet integration changes --- managed in Kibana →
    Fleet UI.

-   Kibana saved-object updates (dashboards, ML jobs) --- Kibana UI or
    saved-object API; not in scope of the Elasticsearch tooling.

**5. Conclusion**

Today\'s work landed the highest-impact single change available ---
taming the rollover storm via ILM. That delivers an estimated 51%
reduction in shard count over 45 days, with the AutoOps shard-violation
events expected to clear in 8--12 weeks once the max\_shards\_per\_node
ladder finishes. The two designed follow-ups (max\_shards lowering and
kubernetes.state consolidation) close the loop on the AutoOps register.

Beyond that, the 12 levers above represent another \~20% reduction in
storage and \~40% reduction in master heap pressure --- meaningful, but
smaller than today\'s work and each requires its own validation. The
tier-1 levers (mapping optimisation, pipeline cleanup, ap/us-cld
replication, force-switch dev/stg) are the natural next sessions;
together they represent more aggregate upside than today\'s session. The
tier-2 levers (synthetic source, logsdb, downsampling, stale stream
cleanup) are best done in parallel once the templates are touched
anyway.

*Cluster eu-cld · 3935ab4a0d944f778c09ad1e1053c8e0 · 5 May 2026 ·
Optimisation backlog beyond today\'s session*
