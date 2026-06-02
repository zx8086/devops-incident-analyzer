**us-cld Aggressive Tier Downsizing Plan**

Post-Windows Metrics Optimisation --- Accelerated Cost Reduction

March 20, 2026

Executive Summary
=================

Following the Windows metrics optimisation completed on March 20, 2026,
us-cld ingestion dropped from \~13.3M docs/hr to \~326K docs/hr (97.5%
reduction). This dramatically reduced the data flowing through all
tiers, creating immediate downsizing opportunities. This plan targets
aggressive tier reductions to realise cost savings as early as possible,
accepting tighter headroom in exchange for faster payback.

**Current hourly rate: \$19.83/hr (\$173,711/year). Target: \$10--12/hr
(\$87,600--\$105,120/year). Projected annual savings:
\$68,000--\$86,000.**

Current Cluster Configuration
=============================

From Elastic Cloud console, captured March 20, 2026:

  **Tier**                 **Instance Type**   **RAM/zone**   **Storage/zone**   **Zones**   **Hourly Rate**
  ------------------------ ------------------- -------------- ------------------ ----------- -----------------
  Hot + Content            DATAHOT.C6GD        30 GB          900 GB             3           (combined)
  Warm                     DATAWARM.D3         4 GB           760 GB             3           
  Cold                     DATACOLD.D3         8 GB           1.48 TB            3           
  Frozen                   DATAFROZEN.I3EN     30 GB          46.88 TB           3           
  Master                   MASTER.C6GD         8 GB           ---                3           
  ML                       ML.C5D              4 GB           ---                2           \$0.58/hr
  Kibana                   KIBANA.C6GD         24 GB          ---                1           \$1.57/hr
  APM/Fleet/Integrations   ---                 24 GB          ---                1           \$1.57/hr
  **TOTAL**                                    **320 GB**     **149.94 TB**                  **\$19.83/hr**

Current Tier Utilisation (Post-Optimisation)
============================================

  **Tier**   **Disk Used/zone**   **Disk Total/zone**   **Utilisation**   **JVM Heap**
  ---------- -------------------- --------------------- ----------------- --------------
  Hot        220--336 GB          900 GB                24--37%           35--37%
  Warm       70--79 GB            760 GB                9--10%            31--45%
  Cold       419--447 GB          1.48 TB               28--30%           30--36%
  Frozen     6.58--7.12 TB (S3)   46.88 TB (cache)      14--15% S3        22--24%

Phase 1: Immediate Actions (Week 1 --- March 24--28)
====================================================

1A. Hot Tier: 900 GB → 450 GB per zone
--------------------------------------

  **Current**       900 GB storage \| 30 GB RAM \| 15.9 vCPU per zone
  ----------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Target**        450 GB storage \| 15 GB RAM \| 7.9 vCPU per zone
  **Go criteria**   Hot disk utilisation below 50% for 3+ consecutive days
  **Risk**          MEDIUM --- Hot also handles ingest; CPU reduction from 15.9 to 7.9 vCPU may affect ingest throughput during bulk operations. Monitor indexing latency after change.

Justification: Hot tier is at 24--37% disk utilisation (302--336 GB
used). With the 97.5% ingestion reduction, new indices roll over much
less frequently, and the \~1 day of hot data before warm transition is
dramatically smaller. 450 GB provides 115--150 GB headroom (25--33%
free).

### Steps:

1.  Verify hot disk usage has been stable at \<50% for 3 days
    post-change (check March 23)

2.  Navigate to: Elastic Cloud \> us-cld \> Edit \> Hot and Content tier

3.  Change Maximum size per zone from 900 GB to 450 GB (the 450 GB \| 15
    GB RAM \| 7.9 vCPU option)

4.  Click Save. Elastic Cloud will perform a rolling restart --- expect
    15--30 minutes of node replacement

5.  Monitor: Kibana \> Stack Monitoring \> Nodes --- confirm all 3 hot
    nodes healthy, disk \<70%, JVM \<80%

6.  Monitor indexing latency in Stack Monitoring for 24 hours --- if p95
    indexing latency exceeds 500ms, consider upgrading back to 900 GB

1B. Warm Tier: 760 GB → 380 GB per zone (with RAM maintained)
-------------------------------------------------------------

  **Current**       760 GB storage \| 4 GB RAM \| Up to 2.1 vCPU per zone
  ----------------- ----------------------------------------------------------------------------------------------------------------------------------------------------------
  **Target**        380 GB storage \| 2 GB RAM \| Up to 2.1 vCPU per zone
  **Go criteria**   Warm disk \<30% AND no active forcemerge tasks AND warm JVM \<75%
  **Risk**          MEDIUM --- Warm runs shrink + forcemerge operations. 2 GB RAM = 1 GB heap. If forcemerge backlog builds, JVM may spike. Watch for circuit breaker trips.

Justification: Warm is at 9--10% (70--79 GB of 760 GB). Data sits in
warm for only \~1 day (warm at 1d, cold at 2d). Even at 380 GB,
utilisation would be \~20%. The JVM concern (instance \#191 was 45%) is
the main risk factor --- aggressive but achievable.

1C. Cold Tier: 1.48 TB → 760 GB per zone
----------------------------------------

  **Current**       1.48 TB storage \| 8 GB RAM \| Up to 2.1 vCPU per zone
  ----------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Target**        760 GB storage \| 4 GB RAM \| Up to 2.1 vCPU per zone
  **Go criteria**   Cold disk \<50% after pre-reduction data ages to frozen (7 days post-March 20)
  **Risk**          LOW-MEDIUM --- Cold holds data from day 2 to day 7. Pre-reduction high-volume data needs 7 days to age to frozen. After March 27, cold contains only post-reduction data.

Justification: Cold is at 28--30% (419--447 GB of 1.48 TB). However,
this includes pre-reduction data. By March 27, all pre-reduction cold
data will have transitioned to frozen (ILM frozen min\_age: 7d). After
that point, cold will hold only \~5 days of post-reduction data, which
is dramatically smaller. 760 GB provides ample headroom.

**IMPORTANT: Wait until March 27 before applying this change. Apply
simultaneously with or after the hot downsize.**

Phase 2: Frozen Tier Reduction (Month 2--3 --- May--June 2026)
==============================================================

2A. Frozen Tier: 46.88 TB → 23.44 TB per zone
---------------------------------------------

  **Current**       46.88 TB storage \| 30 GB RAM \| 3.9 vCPU per zone (LIMIT REACHED)
  ----------------- -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Target**        23.44 TB storage \| 15 GB RAM \| 1.9 vCPU per zone
  **Go criteria**   S3 data size dropping as 90-day delete removes pre-reduction data. Monitor via cluster stats total\_data\_set\_size.
  **Risk**          LOW --- Frozen cache is LRU. Smaller cache means more S3 fetches for older queries, but the data volume is shrinking. 15 GB RAM still provides adequate JVM for 20K shards.

Justification: The frozen tier holds \~140 TB of S3 capacity at LIMIT
REACHED, but actual S3 data is only 6.58--7.12 TB per zone (14--15%).
The 90-day ILM delete phase will begin removing pre-reduction Windows
metrics (which were \~319M docs/day) starting around June 18, 2026 (90
days after March 20). However, the cache nodes can be downsized earlier
since:

-   The 2.17 TB disk cache is LRU --- a smaller cache just means more S3
    round-trips for rarely-accessed data

-   New data arriving at frozen is 97.5% smaller, so cache pressure
    drops immediately

-   JVM at 22--24% on 30 GB = \~7 GB used. 15 GB heap (7.5 GB on 15 GB
    RAM) is sufficient

**Aggressive option: Apply this downsize in May 2026 (Month 2) rather
than waiting for the full 90-day delete. The S3 data hasn't grown
significantly, and the smaller cache is tolerable since most queries
target recent data.**

2B. Further Frozen Reduction (Month 4+ --- July 2026)
-----------------------------------------------------

After the 90-day delete has been running for 30+ days (by mid-July
2026), the S3 data should have dropped to \<5 TB total. At that point,
evaluate downsizing further to 12.5 TB \| 8 GB RAM per zone, or even
6.25 TB \| 4 GB RAM if query patterns allow.

Phase 3: Ancillary Savings (Month 1--2)
=======================================

3A. ML Tier: Review necessity
-----------------------------

  **Current**   2 nodes × 4 GB RAM = \$0.58/hr (\$5,081/year)
  ------------- -------------------------------------------------------------------------------------------------
  **Action**    If no ML jobs are active, disable ML nodes entirely. Check: GET /\_ml/anomaly\_detectors?size=0

3B. Kibana: Review sizing
-------------------------

Kibana at 24 GB RAM (\$1.57/hr) is large. If us-cld Kibana serves only
the monitoring team (not end-user dashboards), consider reducing to 8 GB
RAM. This requires understanding concurrent user load.

Cost Projection Timeline
========================

  -------------------------------------------------------------------------------------------------------------------------
  **Date**    **Action**                    **Change**                    **New Rate**             **Savings**
  ----------- ----------------------------- ----------------------------- ------------------------ ------------------------
  Mar 20      Baseline (today)              ---                           \$19.83/hr               ---

  Mar 24      Hot: 900→450 GB/zone          -1.35 TB hot storage\         **\~\$16.50/hr**         **\~\$3.33/hr**
                                            -45 GB RAM                                             

  Mar 24      Warm: 760→380 GB/zone         -1.14 TB warm storage\        **\~\$15.70/hr**         **\~\$0.80/hr**
                                            -6 GB RAM                                              

  Mar 27      Cold: 1.48→0.76 TB/zone       -2.16 TB cold storage\        **\~\$14.20/hr**         **\~\$1.50/hr**
                                            -12 GB RAM                                             

  May         Frozen: 46.88→23.44 TB/zone   -70.3 TB frozen cache\        **\~\$10.50/hr**         **\~\$3.70/hr**
                                            -45 GB RAM                                             

  May         ML disable (if unused)        -8 GB RAM                     **\~\$9.90/hr**          **\~\$0.58/hr**

  Jul+        Frozen: further to 12.5 TB    Additional frozen reduction   **\~\$8.50--9.50/hr**    **\~\$1--2/hr**

  **TOTAL**   **All phases complete**                                     **\$8.50--\$10.50/hr**   **\$9--\$11/hr saved**
  -------------------------------------------------------------------------------------------------------------------------

**Annualised savings: \$78,840--\$96,360/year on us-cld alone.**

Phase 1 savings (Week 1 alone): \~\$5.63/hr = \~\$49,300/year ---
realised within the first week.

Go/No-Go Decision Criteria
==========================

  ---------------------------------------------------------------------------------------
  **Phase**    **Go Criteria**                  **No-Go / Rollback Trigger**
  ------------ -------------------------------- -----------------------------------------
  1A: Hot      Hot disk \<50% for 3 days\       Hot disk \>70% after downsize\
               No ILM errors\                   Indexing latency p95 \>500ms\
               Indexing latency p95 \<200ms     ILM errors appear

  1B: Warm     Warm disk \<30%\                 Warm JVM \>85% sustained\
               Warm JVM \<75%\                  Circuit breaker trips\
               No active forcemerge tasks\      Forcemerge failures
               No ILM errors                    

  1C: Cold     All pre-Mar-20 data in frozen\   Cold disk \>75% after downsize\
               Cold disk \<50%\                 ILM transition failures
               Cold JVM \<60%                   

  2A: Frozen   S3 data size stable/declining\   Frozen JVM \>80%\
               Frozen JVM \<50%\                S3 query latency \>10s for recent data\
               Query latency acceptable         Shards failing to mount
  ---------------------------------------------------------------------------------------

Rollback Procedure
==================

All tier changes are reversible via the Elastic Cloud Edit page:

7.  Navigate to Elastic Cloud \> us-cld \> Edit

8.  Select the tier to resize back to original size

9.  Click Save --- Elastic Cloud performs a rolling node replacement
    (15--30 minutes)

10. No data loss occurs --- Elastic Cloud migrates shards during the
    resize

**Rollback time: \~15--30 minutes per tier. Multiple tiers can be rolled
back simultaneously.**

Monitoring Queries
==================

Run these in Kibana Dev Tools after each phase to validate:

**Cluster health and disk:**

GET \_cluster/health

GET \_nodes/stats/fs,jvm?filter\_path=nodes.\*.fs.total,nodes.\*.jvm.mem

**ILM errors (must be zero):**

GET \_ilm/explain?only\_errors=true&only\_managed=true

**Indexing latency (hot tier health):**

GET \_nodes/stats/indices?filter\_path=nodes.\*.indices.indexing

**Frozen S3 data size (for Phase 2 decision):**

GET
\_cluster/stats?filter\_path=indices.store.total\_data\_set\_size\_in\_bytes

Applicability to Other Clusters
===============================

eu-cld and ap-cld have similar Windows metrics patterns and will receive
the same ingestion optimisation. Once those changes are applied:

-   eu-cld: Current rate \~\$28--32/hr --- similar downsizing potential
    of 40--50%

-   ap-cld: Current rate \~\$8--10/hr --- moderate downsizing potential
    of 30--40%

-   eu-b2b: Already optimised at \~\$8.36/hr --- no Windows metrics,
    limited further opportunity

**Combined potential across all four clusters: \$150,000--\$200,000/year
in Elastic Cloud cost reduction from the ingestion + tier downsizing
programme.**

*Document generated from live Elastic Cloud console and Elasticsearch
MCP data on March 20, 2026.*
