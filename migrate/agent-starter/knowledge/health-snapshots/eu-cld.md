**EU-CLD HEALTH REPORT & EMERGENCY FIX**

13 April 2026 \| Critical: Broken ILM on Production B2C Streams

Cluster: 3935ab4a0d944f778c09ad1e1053c8e0 \| Version: 9.2.3 \| 30 nodes
\| 22,650 shards

Table of Contents

1\. Cluster Health Summary

2\. Critical Finding: Broken ILM on Production B2C Log Streams

3\. Root Cause Analysis

4\. Emergency Fix Procedure

5\. Ingestion Volume Analysis

6\. Outstanding Issues Status

7\. Playbook Actions Available

8\. Additional Findings

1\. Cluster Health Summary

Assessed 13 April 2026 via Elasticsearch MCP tools. Cluster is GREEN
with 0 ILM errors, 0 pending tasks, and 0 unassigned shards. ILM is
RUNNING. Only 1 forcemerge task active (healthy).

  ------------ ----------- ------------- ----------- --------------- ------------ ----------- ----------- ------------
  **Tier**     **Nodes**   **JVM Max**   **JVM %**   **Disk Size**   **Disk %**   **CPU %**   **OldGC**   **Status**
  **Hot**      9           30 GB         47--72%     1.7 TB/node     10--86%      1--45%      0           ⚠ 2 at 86%
  **Warm**     5           4--7.5 GB     17--62%     0.6--1.1 TB     53--85%      1--51%      0           Forcemerge
  **Cold**     3           15 GB         27--47%     2.2 TB/node     22--25%      0%          0           OK
  **Frozen**   6           30 GB         14--59%     4.4 TB/node     98%          0%          0           Monitor
  **Master**   3           4 GB          45--72%     216 GB          0%           0%          0           OK
  **Ingest**   3           4 GB          29--66%     104 GB          0%           28--65%     4--6        OK
  **ML**       1           0.4 GB        90%         12 GB           0%           0%          36,668      ⚠ Broken
  ------------ ----------- ------------- ----------- --------------- ------------ ----------- ----------- ------------

Changes Since 22 March Implementation Plan

-   Hot tier expanded from 6 to 9 nodes (added instances 144, 145, 146)

-   Warm tier expanded from 3 to 5 nodes (added instances 147, 148 at
    7.5 GB JVM; original 3 remain at 4 GB)

-   Frozen tier expanded from 3 to 6 nodes (added instances 149,
    150, 151)

-   Cold tier disk improved: 22--25% (was 30--34%)

-   Total shards increased from 14,152 to 22,650 (+60%) --- driven by
    unmanaged index growth

2\. Critical Finding: Broken ILM on Production B2C Log Streams

CRITICAL: 9 production B2C ecom data streams are completely unmanaged
--- no ILM policy, no rollover, no shrink, no forcemerge, replicas still
at 1. These indices have been growing unbounded on hot since \~22 March
2026 and are consuming \~5.8 TB of hot tier disk (primary + replica).

  ---------------------------------------- ------------- ------------------ ------------------ -----------------
  **Data Stream**                          **Docs**      **Primary Size**   **Replica Size**   **Hot Node(s)**
  logs-prd-b2c-ecom-prd-wcs-ts-app         1.42B         751.6 GB           755.7 GB           141, 112
  logs-prd-b2c-ecom-api-prd-transformers   1.06B         679.4 GB           672.5 GB           145, 113
  logs-prd-b2c-ecom-prd-frontend           738M          857.6 GB           853.1 GB           140, 139
  logs-prd-b2c-ecom-prd-alb                679M          635.0 GB           635.5 GB           112, 144
  logs-prd-b2c-ecom-prd-wcs-ts-app-sch     126M          (smaller)          (smaller)          ---
  \+ 4 smaller streams                     \~25M         ---                ---                ---
  **TOTAL**                                **\~4.05B**   **\~2.9 TB**       **\~2.9 TB**       **\~5.8 TB**
  ---------------------------------------- ------------- ------------------ ------------------ -----------------

Hot Node Disk Pressure Analysis

The unmanaged indices are the direct cause of hot tier disk pressure.
Two nodes are at 86% and a third at 83%, all dominated by these bloated
indices:

  ------------------------- ---------------- ----------------- -------------------- -------------------------------
  **Hot Node**              **Total Disk**   **Disk Used %**   **Unmanaged Load**   **Status**
  **instance-0000000112**   1,705 GB         86%               1,390.7 GB (82%)     Critical --- 2 giant indices
  **instance-0000000140**   1,705 GB         86%               857.6 GB (50%)       Critical --- frontend primary
  instance-0000000139       1,705 GB         83%               853.1 GB (50%)       High --- frontend replica
  instance-0000000145       1,705 GB         65%               679.4 GB (40%)       Moderate
  instance-0000000113       1,705 GB         54%               672.5 GB (39%)       Moderate
  instance-0000000141       1,705 GB         49%               751.6 GB (44%)       Moderate
  instance-0000000144       1,705 GB         44%               635.5 GB (37%)       OK
  ------------------------- ---------------- ----------------- -------------------- -------------------------------

**Without intervention, instance-0000000112 will hit the 90% watermark
within days, triggering shard relocation flood. Instance-0000000140 is
in the same trajectory.**

3\. Root Cause Analysis

**Cause:** Index template priority conflict. A rogue template overrides
the correct one, stripping ILM lifecycle configuration from all new
backing indices.

Template Conflict Detail

-   logs-prd-b2c-ecom (priority 200): Correct template. Sets ILM policy
    infrastructure-observability-logs. Composes with logs\@mappings,
    logs\@settings, ecs\@mappings, b2c-ecom\@custom. Matches
    logs-prd-b2c-ecom\*.

-   logs-prd-custom-pipeline (priority 262): Rogue template. Created 19
    March 2026. Empty template body --- no ILM lifecycle, no settings,
    no composed\_of. Matches logs-prd-\*. Higher priority wins,
    overriding the correct template.

Because logs-prd-custom-pipeline has priority 262 \> 200 and its pattern
logs-prd-\* also matches logs-prd-b2c-ecom\*, every new backing index
created after 19 March inherited the empty template. No ILM, no logsdb
mode, no synthetic source, no standard mappings.

Same Issue on Staging

-   logs-stg-b2c-ecom (priority 200): Correct template with ILM.

-   logs-stg-retention-and-pipeline (priority 261): Override template.
    Created 19 March 2026. Empty template body but does compose standard
    component templates. Still missing ILM lifecycle. Affected:
    logs-stg-b2c-ecom-stg-alb at minimum.

4\. Emergency Fix Procedure

Execute all commands in Kibana Dev Tools. Verify each step before
proceeding to the next. Estimated total time: 15--20 minutes.

Step 1: Delete Rogue Templates

Remove the templates that are overriding the correct ILM configuration:

> DELETE \_index\_template/logs-prd-custom-pipeline
>
> DELETE \_index\_template/logs-stg-retention-and-pipeline

Verification: confirm the correct templates are now the highest-priority
match:

> GET \_index\_template/logs-prd-b2c-ecom
>
> GET \_index\_template/logs-stg-b2c-ecom

Confirm both show lifecycle.name: infrastructure-observability-logs (or
the appropriate nonprod variant for stg).

Step 2: Rollover All Affected Production Data Streams

Force-rollover each stream so the next backing index picks up the
correct template with ILM:

> POST logs-prd-b2c-ecom-prd-wcs-ts-app/\_rollover
>
> POST logs-prd-b2c-ecom-api-prd-transformers/\_rollover
>
> POST logs-prd-b2c-ecom-prd-frontend/\_rollover
>
> POST logs-prd-b2c-ecom-prd-alb/\_rollover
>
> POST logs-prd-b2c-ecom-prd-wcs-ts-app-sch/\_rollover
>
> POST logs-prd-b2c-ecom-prd-wcs-payments/\_rollover
>
> POST logs-prd-b2c-ecom-prd-wcs-ts-web/\_rollover
>
> POST logs-prd-b2c-ecom-prd-wcs-ts-utils/\_rollover
>
> POST logs-prd-b2c-ecom-prd-s3/\_rollover

Step 3: Rollover Affected Staging Data Stream

> POST logs-stg-b2c-ecom-stg-alb/\_rollover

Step 4: Verify New Indices Have ILM

After rollover, check that the new backing indices are ILM-managed:

> GET logs-prd-b2c-ecom-prd-wcs-ts-app/\_ilm/explain?only\_managed=true
>
> GET
> logs-prd-b2c-ecom-api-prd-transformers/\_ilm/explain?only\_managed=true

Confirm each new index shows managed: true with policy:
infrastructure-observability-logs.

Step 5: Handle the Old Giant Indices

The old unmanaged backing indices (the 751 GB+ monsters) will not
automatically pick up ILM because they are no longer the write index.
Two options:

**Option A (recommended):** Manually assign the ILM policy to the old
indices. This will trigger them to age through warm/cold/frozen
normally:

> PUT .ds-logs-prd-b2c-ecom-prd-wcs-ts-app-2026.03.23-001130/\_settings
>
> { \"index.lifecycle.name\": \"infrastructure-observability-logs\" }

Repeat for each of the 9 old backing indices. They will immediately
begin ILM evaluation and start moving to warm (shrink, forcemerge, 0
replicas).

**Option B:** Leave them alone. They will remain on hot with replicas=1
until the retention delete phase catches up (90+ days from their
creation date in March). Not recommended due to hot tier disk pressure.

WARNING: When Step 5 Option A triggers ILM on the giant indices, warm
will receive a burst of shrink/forcemerge work on \~2.9 TB of primary
data. Monitor warm CPU and JVM closely. If forcemerge count exceeds 20:
POST \_ilm/stop, wait for completion, POST \_ilm/start. The staggered
rollout rules from the playbook apply.

Step 6: Clean Up Empty Security Solution Indices

These 4 empty indices from January can be deleted safely:

> DELETE security\_solution-aws.misconfiguration\_latest-v2
>
> DELETE security\_solution-aws.misconfiguration\_latest-v3
>
> DELETE security\_solution-awsconfig.misconfiguration\_latest-v1
>
> DELETE security\_solution-awsinspector.vulnerability\_latest-v1

5\. Ingestion Volume Analysis

Metrics (Top Datasets, 1-Hour Sample)

  ------------------------------ -------------- ---------------- ---------------------
  **Dataset**                    **1hr Docs**   **Est. Daily**   **Notes**
  transaction.1m.otel            28.2M          \~677M           ts-app-sch dominant
  service\_transaction.1m.otel   28.2M          \~677M           ts-app-sch dominant
  apm.service\_destination.1m    6.0M           \~144M           APM rollup
  hostmetricsreceiver.otel       1.1M           \~27M            OTel host metrics
  kubeletstatsreceiver.otel      1.1M           \~26M            K8s stats
  windows.service                471K           \~11M            Filter holding
  system.process                 462K           \~11M            Stable
  ------------------------------ -------------- ---------------- ---------------------

Logs (Top Datasets, 1-Hour Sample)

  ---------------------------- -------------- ---------------- ------------------------
  **Dataset**                  **1hr Docs**   **Est. Daily**   **Notes**
  generic.otel (logs)          9.8M           \~236M           OTel logs
  gkpos                        7.0M           \~168M           GK PoS till logs
  kubernetes.container\_logs   4.7M           \~113M           K8s container logs
  cisco\_meraki.log            3.1M           \~75M            Network logs
  cisco\_ftd.log               2.8M           \~67M            Firewall logs
  genius.app                   2.7M           \~64M            CXF SOAP payload issue
  elastic\_agent.filebeat      1.9M           \~46M            Agent logs --- review
  ---------------------------- -------------- ---------------- ------------------------

OTel Volume Breakdown (ts-app-sch)

The transaction.1m.otel and service\_transaction.1m.otel datasets
together account for \~56.5M docs/hour (\~1.35B/day). The top service
contributors in the last hour:

-   ts-app-sch-staging-blue: 13.2M/hr (47% of total)

-   ts-app-sch-live-blue: 6.3M/hr (22%)

-   ts-app-sch-staging-green: 3.5M/hr (12%)

-   ts-app-sch-live-green: 2.7M/hr (10%)

This is unchanged from March. Remains a B2C ecom team application-level
dependency.

6\. Outstanding Issues Status

Resolved Since March

-   b2c-temp-logs orphan indices: CLEANED UP (no longer present)

-   blue-yonder-logs orphan indices: CLEANED UP (no longer present)

Still Outstanding

-   ML node \#123: JVM at 90%, 36,668 old GC collections. Requires
    remediation or removal.

-   4x security\_solution-\* empty indices: Still present (fix in Step 6
    above).

-   ts-app-sch OTel instrumentation surge: \~1.35B metrics/day. App team
    dependency, no change.

-   GK PoS credential exposure (JSESSIONID/Auth tokens): Open since
    March. Security risk.

-   elastic\_agent.filebeat volume: 1.9M/hr from eu\_pos\_gk\_till.
    Review whether agent logs can be suppressed.

-   genius.app CXF SOAP payload logging: 2.7M/hr. Payloads should not be
    in observability logs.

-   363 Elastic agents on P1 versions: Blocking Citrix service filter
    fix.

-   Warm tier mixed sizing: 3 nodes at 4 GB, 2 nodes at 7.5 GB. Consider
    standardising to 8 GB.

-   Standalone orphan indices: storewatch-\*, store-details-enriched-\*,
    storefront-data, gk\_pos\_alive\_health\_status. Small, static, no
    ILM. Assign policy or clean up with team confirmation.

New Issues Identified This Session

-   CRITICAL: logs-prd-custom-pipeline template override breaking ILM on
    9 production B2C data streams (fix procedure in Section 4).

-   CRITICAL: logs-stg-retention-and-pipeline template override on
    staging (fix included in Section 4).

-   Shard count regression: 22,650 (was 14,152 on 22 March). +60% driven
    by unmanaged index growth and cluster expansion.

7\. Playbook Actions Available

Cross-referencing current cluster state against the Cluster Optimisation
Playbook v2:

Phase 0: Cluster Assessment --- DONE (this report)

Health check, node inventory, ILM audit, volume analysis all completed.

Phase 1: ILM Policy Standardisation

-   All 26 named policies were updated in March and remain correct.

-   The issue is not with the policies themselves but with the index
    template routing --- the rogue template bypasses the correct policy
    assignment.

-   After template fix (Section 4), ILM will resume normal operation on
    all new indices.

Phase 2: Fleet Ingestion Volume Reduction

-   windows.service filter: HOLDING at \~471K/hr (was 278M/day
    pre-filter). Confirmed effective.

-   windows.perfmon: HOLDING. PhysicalDisk only confirmed.

-   system.core: HOLDING at zero.

-   elastic\_agent metrics: HOLDING at \~100K/day from EC internal hosts
    only.

-   Deferred fixes (3/5/6): system.diskio, system.filesystem,
    system.network filtering still available. Est. \~10M additional
    docs/day reduction.

-   elastic\_agent.filebeat (logs): 1.9M/hr. New opportunity ---
    consider disabling agent log collection on high-volume GK PoS
    policies.

Phase 3: Data Cleanup

-   Orphan cleanup: b2c-temp-logs and blue-yonder-logs already cleaned.
    security\_solution-\* ready to delete (Section 4 Step 6).

-   Standalone indices (storewatch-\*, etc.): Ready for cleanup with
    team confirmation.

-   Dead data stream audit: Recommend re-running after template fix to
    identify any streams that should be retired.

Phase 4: Infrastructure Downsizing

NOT YET READY. The cluster expanded significantly since March (9 hot, 5
warm, 6 frozen). Downsizing is blocked until:

-   Template fix is applied and unmanaged indices start aging through
    ILM (1--2 weeks for warm/cold transition).

-   Hot tier disk normalises below 60% (expected after old indices move
    to warm and replicas drop to 0).

-   Cold tier continues to look healthy at 22--25%.

-   Frozen 98% cache pressure should be monitored but is not data
    pressure --- verify S3 usage in Cloud console per playbook.

Estimated downsizing window: 4--6 weeks after template fix, consistent
with playbook guidance of steady state for 4--6 weeks before resizing.

8\. Additional Findings

8.1 Staging Streams Stuck in hot:rollover (Policy Design Issue)

6 staging B2C ecom data streams are stuck in hot:rollover, some for over
377 days. The root cause is the
infrastructure-observability-logs-nonprod policy, which includes
min\_primary\_shard\_size: 1gb as a rollover gate. Low-volume staging
streams never reach 1 GB, so max\_age: 1d cannot trigger rollover.

Affected streams (all on infrastructure-observability-logs-nonprod):

-   logs-stg-b2c-ecom-stg-s3: 609 MB, 377 days old

-   logs-stg-b2c-ecom-stg-wcs-ts-utils: 8.5 MB, 377 days old

-   logs-stg-b2c-ecom-stg-frontend: created 22 March 2026

-   logs-stg-b2c-ecom-stg-wcs-payments: created 11 March 2026

-   logs-stg-b2c-ecom-stg-wcs-ts-app: created 22 March 2026

-   logs-stg-b2c-ecom-stg-wcs-ts-web: created 18 March 2026

**Fix:** Remove the min\_primary\_shard\_size: 1gb condition from the
nonprod policy. It blocks time-based rollover on low-volume streams,
causing them to sit on hot indefinitely. The correct approach is
max\_primary\_shard\_size (ceiling) without a min gate. After policy
fix, force-rollover each stale stream:

> POST logs-stg-b2c-ecom-stg-s3/\_rollover
>
> POST logs-stg-b2c-ecom-stg-wcs-ts-utils/\_rollover
>
> POST logs-stg-b2c-ecom-stg-frontend/\_rollover
>
> POST logs-stg-b2c-ecom-stg-wcs-payments/\_rollover
>
> POST logs-stg-b2c-ecom-stg-wcs-ts-app/\_rollover
>
> POST logs-stg-b2c-ecom-stg-wcs-ts-web/\_rollover
>
> POST logs-stg-b2c-ecom-stg-wcs-ts-app-sch/\_rollover

8.2 Third Template at Risk: logs-nonprod-retention-fleet

Template logs-nonprod-retention-fleet (priority 251, created 6 April
2026) matches 10 namespace patterns (logs-\*-eu\_\*\_stg,
logs-\*-eu\_\*\_dev, etc.). It has an empty template body but does
compose logs\@settings and other standard components. Indices created
under this template may inherit ILM from logs\@settings, but the intent
should be verified. This template was not the cause of the prd/stg
breakage but follows the same risky pattern of empty template bodies at
elevated priority.

8.3 Production Policy Deviation from Playbook

The infrastructure-observability-logs policy (v23, modified 8 April
2026) deviates from the playbook standard template in two ways:

-   Rollover: 10 GB max\_primary\_shard\_size + 1d max\_age (playbook: 2
    GB / 7d). This is appropriate for high-volume log streams but should
    be documented as an intentional deviation.

-   Cold min\_age: 5d (playbook: 2d). Data stays on warm 4 extra days.
    Consider reducing to 2--3d after confirming warm forcemerge
    completes within 24 hours for these stream sizes.

8.4 Shard Count Regression

Total shards increased from 14,152 (22 March) to 22,650 (+60%).
Contributing factors:

-   Unmanaged prd indices: 9 indices with replicas=1 = 18 extra shards,
    but each shard is 600--860 GB (vs target 2 GB), so the storage
    impact dwarfs the shard count impact.

-   Cluster expansion: 6→9 hot nodes, 3→5 warm, 3→6 frozen. More nodes
    can host more shards.

-   Normal data growth over 3 weeks of operation.

After the template fix and ILM resumption, shard count should stabilise
as old indices get shrunk to 1 shard in warm.

*Generated from live eu-cld cluster data on 13 April 2026 using
Elasticsearch MCP tools. All rates verified from 1-hour samples.
Previous revision: eu-cld Implementation Plan Rev 3 Final (22 March
2026).*
