**eu-cld Cold Tier Capacity Incident & Remediation Plan**

*21 April 2026 --- Platform Engineering*

Executive summary

On 21 April 2026 the eu-cld cold tier breached the high-watermark
threshold on all three cold data nodes, with disk utilisation ranging
from 87% to 91%. The cluster remained green with zero unassigned shards
and zero pending tasks, but the headroom on node 114 reduced to
approximately 194 GB before flood-stage read-only enforcement would
trigger.

Investigation confirmed the cause to be a mismatch between provisioned
cold-tier capacity (2.17 TB per zone) and the volume of 5-to-7-day-old
data that accumulates given the current ILM phase transitions. ILM
itself was operating correctly; no indices were stuck and phase
transitions were progressing on schedule. A secondary contributor was
identified: one ILM policy (eu-default-lifecycle-metrics-prod, 786
indices) remains on the legacy 2 GB hot-rollover threshold, producing
approximately five rollovers per day per data stream and inflating index
counts without reducing data volume.

Immediate remediation began with increasing the cold-tier autoscaling
ceiling via the Elastic Cloud console. Two further actions are
recommended: bringing the outlier ILM policy into alignment with the
Path B 10 GB rollover pattern already deployed on the other eu-default
policies, and scheduling a stakeholder review of 90-day retention on the
top six policies.

Current cold-tier state

  ------------------------- --------------- ---------------- ------------ -----------------------------------------
  **Node**                  **Zone**        **Disk used**    **% used**   **Status**
  **instance-0000000114**   eu-central-1a   2.03 / 2.17 TB   **91.4%**    Above high watermark; \~194 GB to flood
  **instance-0000000115**   eu-central-1c   2.00 / 2.17 TB   **89.9%**    At/above high watermark; self-draining
  **instance-0000000116**   eu-central-1b   1.94 / 2.17 TB   **87.9%**    Near high watermark; self-draining
  ------------------------- --------------- ---------------- ------------ -----------------------------------------

Root cause analysis

Primary cause: cold-tier capacity undersized for retained volume

The cold tier is provisioned at 2.17 TB per zone, which is the current
autoscaling ceiling. This capacity was historically adequate but has
become insufficient following the post-March 2026 ingestion growth. With
warm-to-cold transitions occurring at day 1 to day 5 and cold-to-frozen
transitions at day 5 to day 7 (depending on policy), the cold tier holds
a 2-to-6-day window of all observability data across approximately
22,000 indices cluster-wide.

The cold tier is operating as designed --- no indices are stuck in a
lifecycle phase, no ILM errors are present, and transitions to the
frozen tier are progressing normally. The issue is purely a capacity
mismatch, not a lifecycle malfunction.

Secondary cause: outlier ILM policy on 2 GB rollover

One ILM policy, eu-default-lifecycle-metrics-prod (version 4, last
modified 20 March 2026), still uses a 2 GB hot-rollover threshold. This
policy manages 786 indices across OpenTelemetry metrics data streams
including metrics-generic.otel-default,
metrics-kubeletstatsreceiver.otel-default,
metrics-hostmetricsreceiver.otel-default, and several transaction rollup
streams.

Evidence of excessive rollover frequency on this policy was observed in
the metrics-generic.otel-default data stream, which produces
approximately 5 indices per 24-hour period (rollover every \~5 hours at
2 GB). The other three eu-default policies (logs-prod, traces-prod, and
logs-nonprod) were already migrated to the 10 GB rollover pattern on 8
April 2026 as part of Path B consolidation. The metrics policy appears
to have been missed during that work.

While this policy does not drive the immediate disk pressure (the
underlying data volume is unchanged), it produces unnecessary
cluster-state churn and inflates the index count on the cold tier.

Not contributing factors

-   Cluster health: GREEN with 22,141 primary shards, 24,552 active
    shards, 0 unassigned, 0 pending tasks.

-   Top two ILM policies (infrastructure-observability-logs, -metrics)
    covering approximately 16,000 indices are already correctly
    configured on 10 GB rollover.

-   Warm tier capacity is adequate --- nodes are at 48% to 57%
    utilisation.

-   Frozen tier capacity is adequate --- nodes are at approximately 11%
    of disk cache utilisation, well below the previously raised 46.88
    TB/zone ceiling.

-   The autoscaling warning banner shown in the console for warm and
    frozen tiers reflects a ceiling-reached condition from prior tuning,
    not an active capacity shortfall.

Remediation plan

Action 1 --- Increase cold-tier autoscaling ceiling

Status: In progress (started 21 April 2026).

Action: Raise cold-tier max-size-per-zone from 2.17 TB to a minimum of 3
TB (recommended 3.5 TB) via the Elastic Cloud console under Edit
deployment → Cold data.

Rationale: This is the fastest path to eliminating disk pressure without
any cluster-side configuration change. Autoscaling will provision the
additional capacity only if data volume continues to require it, so this
does not impose a cost floor --- it removes a cost ceiling. No downtime,
no data movement, no risk to existing indices.

Expected outcome: Once autoscaling provisions the new capacity,
cold-tier utilisation should fall below the high watermark (7% free) and
stabilise well below the low watermark (10% free). The existing
self-draining behaviour observed on nodes 115 and 116 will continue to
move aged shards to the frozen tier at their configured min\_age.

Action 2 --- Align eu-default-lifecycle-metrics-prod with Path B

Status: Planned for execution once cold-tier disk pressure has eased
(nodes below 85%).

Action: Update the hot-phase rollover from 2 GB to 10 GB, matching the
pattern already deployed on eu-default-lifecycle-logs-prod,
eu-default-lifecycle-traces-prod, and eu-default-lifecycle-logs-nonprod.
All other phases remain unchanged --- retention, tier transitions,
shrink, and forcemerge behaviour preserved.

Method: Apply via Kibana Dev Tools when timing is favourable. Fleet does
not manage this policy, so the change will not auto-revert.

Impact: Existing indices are not affected --- they are already past
rollover and continue through warm, cold, frozen, and delete on their
current schedule. Future rollovers create one larger index per data
stream per day instead of approximately five smaller ones. Net result is
an estimated 80% reduction in rollover frequency on affected streams,
with corresponding reductions in cluster-state churn and shard count on
the cold tier going forward.

**Proposed policy body:**

PUT \_ilm/policy/eu-default-lifecycle-metrics-prod

{

\"policy\": {

\"phases\": {

\"hot\": {

\"min\_age\": \"0ms\",

\"actions\": {

\"rollover\": {

\"max\_age\": \"24h\",

\"max\_primary\_shard\_size\": \"10gb\"

},

\"set\_priority\": { \"priority\": 100 }

}

},

\"warm\": {

\"min\_age\": \"1d\",

\"actions\": {

\"allocate\": {

\"number\_of\_replicas\": 0,

\"include\": {}, \"exclude\": {}, \"require\": {}

},

\"forcemerge\": { \"max\_num\_segments\": 1 },

\"set\_priority\": { \"priority\": 50 },

\"shrink\": {

\"number\_of\_shards\": 1,

\"allow\_write\_after\_shrink\": false

}

}

},

\"cold\": {

\"min\_age\": \"5d\",

\"actions\": {

\"allocate\": {

\"number\_of\_replicas\": 0,

\"include\": {}, \"exclude\": {}, \"require\": {}

},

\"set\_priority\": { \"priority\": 0 }

}

},

\"frozen\": {

\"min\_age\": \"7d\",

\"actions\": {

\"searchable\_snapshot\": {

\"snapshot\_repository\": \"found-snapshots\",

\"force\_merge\_index\": true

}

}

},

\"delete\": {

\"min\_age\": \"90d\",

\"actions\": {

\"delete\": { \"delete\_searchable\_snapshot\": true },

\"wait\_for\_snapshot\": { \"policy\": \"cloud-snapshot-policy\" }

}

}

}

}

}

Action 3 --- 90-day retention audit (stakeholder review)

Status: Proposed; requires stakeholder engagement before execution.

Action: Convene a data-retention review with owners of the top six
policies, where total retention is currently 90 days across warm, cold,
and frozen phases. The purpose is to validate whether the current
retention is operationally necessary or whether shorter retention would
meet actual use cases.

**Top six policies by index count:**

  --------------------------------------- ------------- ------------------ -------------- ---------------
  **Policy**                              **Indices**   **Data streams**   **Rollover**   **Retention**
  infrastructure-observability-logs       8,371         362                10 GB          90d
  infrastructure-observability-metrics    7,680         598                10 GB          90d
  eu-default-lifecycle-traces-prod        2,733         ---                10 GB          90d
  eu-default-lifecycle-logs-prod          1,391         5                  10 GB          90d
  **eu-default-lifecycle-metrics-prod**   786           ---                **2 GB**       90d
  metrics                                 362           466                10 GB          90d
  --------------------------------------- ------------- ------------------ -------------- ---------------

Combined scope: approximately 21,300 indices are under 90-day retention
via these six policies. Even partial reductions (for example, from 90
days to 60 days on selected data streams) would materially reduce
cold-tier and frozen-tier footprint over the following retention cycle.
This is explicitly not a platform-engineering decision and must be
driven by data owners.

-   Suggested question for owners: is a 90-day window on
    warm+cold+frozen still operationally required, or would 30 or 60
    days meet current use cases?

-   Suggested separation: consider different retentions for production
    versus non-production data streams --- nonprod policies already run
    at 14 or 30 days and serve as reference.

-   Impact quantification can be produced per data stream if a review
    meeting is scheduled.

Self-healing evidence

During the investigation window on 21 April, cold tier disk usage was
sampled twice at a five-minute interval. Nodes 115 and 116 reduced
utilisation independently as ILM transitioned aged shards to the frozen
searchable-snapshot phase:

  ---------- --------------- ------------------- ----------- --------------------------
  **Node**   **Free @ T0**   **Free @ T+5min**   **Delta**   **Behaviour**
  **114**    204.15 GB       204.15 GB           0           Not draining --- monitor
  **115**    206.51 GB       228.54 GB           +22 GB      Draining via cold→frozen
  **116**    240.09 GB       288.05 GB           +48 GB      Draining via cold→frozen
  ---------- --------------- ------------------- ----------- --------------------------

This confirms the ILM cold-to-frozen transition is functioning correctly
and that nodes 115 and 116 will continue to trend downward organically.
Node 114 did not drain in the sample window and will be monitored --- it
may simply hold shards whose ages fall in the middle of the cold phase
(5-to-7 days old) and will drain once they reach 7 days. No manual
intervention is currently required on the cold tier.

Monitoring and success criteria

The following checkpoints will confirm remediation success:

-   Cold tier disk utilisation below 85% on all three nodes within 48
    hours of autoscaling increase.

-   Cold tier disk utilisation stable below 75% within one retention
    cycle (7 days).

-   No ILM errors appearing in the cluster (confirmed by periodic
    onlyErrors explain\_lifecycle checks).

-   No flood-stage read-only enforcement events.

-   Post Action 2: metrics-generic.otel-default rollover frequency drops
    from approximately 5 per day to 1 per day per data stream.

-   Post Action 3 (if retention reductions agreed): measurable reduction
    in total cluster shard count over following 30-to-90-day window.

Outstanding items and next steps

The following items extend beyond the immediate cold-tier incident but
are relevant context:

-   The ts-app-sch OTel DB2/JDBC auto-instrumentation issue (B2C
    ecommerce team, escalation sent 14 April) remains the root upstream
    driver of post-March ingestion volume growth. Recent daily index
    sizes for this stream have returned to 400 MB to 3 GB (throttled),
    but the older data is now propagating through the tiers.

-   eu-cld Phase 4 work (reduce warm min\_age 3d to 1d, orphan index
    cleanup, dead data stream audit, security\_solution-\* empty index
    review) remains outstanding.

-   363 Elastic agents on P1 versions still blocking Citrix filter fix.

-   ML node 123 remediation (1 GB RAM, degraded) still pending.

-   A snapshot deletion operation was observed in progress during this
    investigation (repository found-snapshots). This is routine and does
    not affect disk directly but was noted for context.

Appendix --- cluster snapshot (21 April 2026)

-   Cluster: eu-cld (3935ab4a0d944f778c09ad1e1053c8e0)

-   Elasticsearch version: 9.2.3

-   Status: GREEN

-   Nodes: 25 total --- 6 hot, 3 warm, 3 cold, 6 frozen, 3 master, 3
    ingest, 1 ML

-   Primary shards: 22,142 \| Active shards: 24,552 \| Unassigned: 0 \|
    Pending: 0

-   Indices: 22,045 \| Docs: 257.6B \| Store: 10.1 TB primary+replica \|
    Total dataset: 78.6 TB including frozen searchable snapshots

-   Remote CCS peers: eu-b2b, ap-cld, us-cld (all reachable)
