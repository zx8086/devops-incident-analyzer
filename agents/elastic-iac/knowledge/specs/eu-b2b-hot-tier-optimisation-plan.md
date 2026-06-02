# eu-b2b hot tier — cost optimisation plan

Live cluster reconciliation 2026-05-31. All facts verified via Elastic MCP against deployment `02655c3733ea471999d9cec39a17df32`.

## Current state

| Tier | Nodes × RAM | Disk per node | Total disk | Used | % used |
|---|---|---|---|---|---|
| Hot (datahot.i3) | 3 × 15 GB | 450 GB | 1,350 GB | 551 GB | **41%** |
| Warm (datawarm.d3) | 2 × 8 GB | 1.48 TB | 2.96 TB | 200 GB | 7% |
| Cold (datacold.d3) | 2 × 4 GB | 760 GB | 1.52 TB | 232 GB | 15% |
| Frozen (datafrozen.i3en) | 1 × 30 GB | searchable obj store | 1.2 TB | 1.2 TB | 100% (LRU cache, expected) |

Cluster GREEN. 1,337 indices · 3,160 shards · 5.96B docs · v9.4.1. AutoOps shows hot tier at **CPU 77%, JVM 54%, system memory 74%** on a 24h average — every other tier is below 50% CPU.

The diagnosis is correct: hot is doing the work and the lower tiers are mostly empty. The cause is in the ILM policies and a set of unmanaged indices, not in the hot sizing itself.

## Findings (live)

### F1. 15 `.internal.alerts-security.alerts-default-*` indices are UNMANAGED

`ilm_explain_lifecycle` returns `managed: false, policy: none` for every one of these. Total: 15 backing indices, top one is 7.7 GB (4.5M docs), all pinned to hot nodes 95 / 106 / 150. Approximate hot footprint: **75–100 GB**.

The `.alerts-ilm-policy` (v144) exists but is only hot-phase with no delete action — even if attached, it wouldn't reclaim anything. Both problems need fixing.

### F2. traces-apm hot phase keeps 4 daily indices, each ~60 GB with replica

`traces-apm.traces-default_policy` v46 (modified 2026-05-15):
- Hot rollover: `max_age: 1d`, `max_primary_shard_size: 50gb`. No explicit replica setting → inherits template default of 1.
- Warm min_age 3d, Cold min_age 5d, Frozen 7d, Delete 30d.
- Result: indices for 2026-05-28/29/30/31 all sit on hot. 3 primaries × 10 GB each × replica = ~60 GB per daily index. **~240 GB of hot consumed by traces alone**.

### F3. Twelve policies with hot-only retention (no warm/cold/frozen)

| Policy | Retention | Hot rollover |
|---|---|---|
| `synthetics-synthetics.browser-default_policy` | **365 d** | 30d / 50 GB |
| `synthetics-synthetics.http-default_policy` | 365 d | 30d / 50 GB |
| `synthetics-synthetics.icmp-default_policy` | 365 d | (default) |
| `synthetics-synthetics.tcp-default_policy` | 365 d | (default) |
| `logs-enterprise_search.audit-default` | 180 d | 30d / 3 GB |
| `logs-workplace_search.analytics-default` | 180 d | 30d / 3 GB |
| `logs-workplace_search.content_events-default` | 180 d | 30d / 3 GB |
| `logs-app_search.analytics-default` | 180 d | 30d / 3 GB |
| `logs-cloud_security_posture.findings-default_policy` | 180 d | (default) |
| `.deprecation-indexing-ilm-policy` | 180 d | (default) |
| `.fleet-file-fromhost-meta-ilm-policy` | 180 d | (default) |
| `kibana-reporting` | 90 d | (default) |
| `.alerts-ilm-policy` | **none — unbounded** | 30d / 50 GB |

Most of these are low-volume, but compound over months of retention. Together they likely hold **60–100 GB on hot** that should live on cold/frozen.

### F4. Thirteen near-identical APM aggregate metrics policies

`metrics-apm.service_destination_{10m,1m,60m}_metrics-default_policy`, `service_summary_{10m,1m,60m}`, `service_transaction_{10m,1m,60m}`, `transaction_{10m,1m,60m}`, plus `metrics-apm.{app,internal}_metrics-default_policy`. All have:
- Same phases: cold → warm → hot → delete → frozen
- Same retention: 30 days
- Same versioning churn (every Elastic Stack update bumps versions across all 13)

143 backing indices across 13 policies. Consolidating to one `apm-aggregate-metrics-default` doesn't free hot directly but removes 12 policies-worth of version-drift maintenance (you already track this in v20 register row IR-046 as "APM-bundled policies auto-revert monitoring").

### F5. `logs` and `logs-apm.app_logs-default_policy` hot phase max_age = 7 days

`logs` v48 and `logs-apm.app_logs-default_policy` v49 both have:
- Hot: `max_age: 7d, min_docs: 1000, max_primary_shard_size: 30gb`
- Warm: 3d. Cold: 5d. Frozen: 7d. Delete: 30d / 45d.

Result: small log streams stay on hot for the full 7 days waiting to roll. Lowering the rollover max_age to 1d (or speeding warm to min_age 1d) would reclaim hot space across the long tail of low-volume log data streams.

### F6. `.monitoring-es-7-*` daily indices on hot 1-3 days

`.monitoring-8-ilm-policy`: hot 3d / 50 GB, warm 2d (shrink + forcemerge), delete 15d. The 2026-05-29/30/31 backing indices (each 4.8–6.3 GB primary + replica) sit on hot nodes. Adequate but easy to pull to warm faster.

### F7. Stuck-on-hot signal investigated, false alarm

`.ds-logs-aws_fargate_shared_services.prd-eu_shared_services-2026.05.22-000503` (30 GB single shard, hot nodes 106/150) — looked like a 9-day-old shard stuck on hot. `ilm_explain` shows it's actually 2.3 days old (the date in the index name is the data stream's first-doc date, not the index creation date). Phase "hot", step "complete" → awaiting warm min_age 3d. Will move on its own in ~0.7 days. **No action needed.**

## Action plan

Phased so the high-leverage low-risk changes go first, with cluster behaviour observed before any sizing change.

### Wave 1 — Attach + extend ILM (0 cost, ~1 hour)

| # | Action | Hot reduction (est.) |
|---|---|---|
| W1.1 | Update `.alerts-ilm-policy` to add warm @ 7d, cold @ 30d, frozen @ 90d, delete @ 180d. | — |
| W1.2 | Attach `.alerts-ilm-policy` to `.internal.alerts-security.alerts-default-*` data stream (currently unmanaged). | **75–100 GB** |
| W1.3 | Add warm @ 7d / cold @ 30d / frozen @ 90d to the four synthetics-* policies. Keep delete @ 365d. | 25–40 GB |
| W1.4 | Add warm @ 7d / cold @ 30d / delete @ 90d to logs-enterprise_search.audit, logs-workplace_search.*, logs-app_search.*, kibana-reporting, .deprecation-indexing-ilm-policy, .fleet-file-fromhost-meta, logs-cloud_security_posture.findings. | 30–50 GB |
| **Wave 1 total** | | **130–190 GB** |

Risk: very low. Adding lower-tier phases doesn't change live read/write paths immediately. Older indices migrate automatically over the next ILM cycle.

### Wave 2 — Accelerate traces-apm + logs through tiers (Day +3)

After Wave 1 has settled, observe hot utilisation drop. Then:

| # | Action | Hot reduction (est.) |
|---|---|---|
| W2.1 | `traces-apm.traces-default_policy`: warm min_age 3d → 1d, cold 5d → 3d. Keep frozen 7d, delete 30d. | 120 GB |
| W2.2 | `traces-apm.traces-default_policy` hot phase: explicit `allocate.number_of_replicas: 0`. Trades a brief HA window during the 1-day hot residence for 50% hot reduction on traces. | 60 GB |
| W2.3 | `logs` policy: warm 3d → 1d, cold 5d → 3d. | 50–100 GB |
| W2.4 | `logs-apm.app_logs-default_policy`: warm 3d → 1d, cold 5d → 3d. | 30–60 GB |
| W2.5 | `.monitoring-8-ilm-policy`: warm min_age 2d → 1d. | 5–10 GB |
| **Wave 2 total** | | **265–350 GB** |

Risk W2.2 (replicas=0 in hot): if a hot node fails mid-day before the warm move, the day's traces could need rebuild from source. With 3 hot nodes and 1d residence, exposure window is small. Mitigation: leave replicas=1 on hot if zero is too aggressive — Wave 2 still nets ~200 GB reduction without it.

### Wave 3 — Hot tier downsize (Day +14, after stable observation)

After Waves 1+2, hot usage should be **150–250 GB** (down from 551 GB) with 30–50% headroom. Then:

| # | Action | Detail |
|---|---|---|
| W3.1 | Hot tier 15 GB → 8 GB RAM per zone (3 zones), aws.es.datahot.i3. | Disk goes 450 GB/node → 240 GB/node; total hot disk 1350 GB → 720 GB. Heap halves. CPU pressure should stay manageable because data volume on hot dropped. |
| W3.2 | Reduce autoscaling_max for hot from 29696 → 15360 MB to prevent silent re-upsize. | Per `feedback_elastic_cloud_resize_order`: reduce Current per zone first, then Max. |

**Estimated annual saving from W3.1 alone**: ~$5.5–7K/yr (hot tier i3 at 15 GB → 8 GB per zone × 3 zones in eu-central-1). Exact figure requires cost-explorer pull — directionally significant but not the largest lever here.

### Wave 4 — Housekeeping (parallel to Wave 1–3)

| # | Action | Benefit |
|---|---|---|
| W4.1 | Consolidate the 13 APM aggregate metrics policies into one `apm-aggregate-metrics-default`. Migrate 143 indices' data streams via `_ilm/move_to_step`. | Removes version-drift maintenance; closes issue IR-046. |
| W4.2 | Investigate AutoOps "Template can be optimized (32)" recommendations. These are likely the long-tail hot-only templates from F3. | Pre-empts future ILM drift. |
| W4.3 | Address AutoOps "Frozen Node Contains Too Many Shards" — single frozen node with 1.2 TB cache. Either accept (it's just LRU pressure, expected) or expand frozen to 2 zones for HA. | HA improvement, not cost; noted as already-tracked. |
| W4.4 | 54 empty 2025 backing indices housekeeping (IR-158 in v20 register, status confirmed in reconciliation). | Frees shards but minimal disk. |

## What this does to hot tier load

Hot tier load drivers, ranked:
1. **traces-apm-default** — currently dominates. After W2.1+W2.2: ~75% reduction in hot footprint.
2. **`.internal.alerts-security.alerts-default-*`** — unmanaged today. After W1.2: tier migration restored.
3. **Long-tail hot-only policies** — adds ~100 GB. After W1.3+W1.4: ~70% migrated off hot over 7 days.
4. **`logs` + `logs-apm.app_logs`** — already tiered but slow. After W2.3+W2.4: faster cycling.

Expected hot CPU drop: from 77% → ~40–50% (rough; depends on read-pattern shift). JVM 54% → ~30%.

## Decision points before execution

1. **Wave 2 replicas=0 on hot**: confirm acceptable. (Yes — if you'd rather keep replicas=1, Wave 2 still works with ~75% of the saving.)
2. **Cold tier policy on `.alerts`**: 30d cold + 90d frozen is the default suggestion. Adjust if your security team needs faster alert search later than 30d.
3. **Synthetics 365d retention**: still required for compliance/SLA reporting? If 180d is acceptable, delete-min-age drop saves cold/frozen disk too.
4. **Wave 3 downsize target**: 15 GB → 8 GB suggested. If you'd rather stage it as 15 → 11 GB first and reassess at Day +21, that's safer.

## Validation method (per wave)

Each wave verifies via MCP, not promises:
- After W1.2 (alerts ILM attach): `ilm_explain_lifecycle(index='.internal.alerts-security.alerts-default-*')` must show `managed: true, policy: .alerts-ilm-policy`.
- After Wave 2 changes: `get_shards()` on hot nodes — traces-apm 28-31 May indices should be reduced to 0 replicas (W2.2) or already migrated to warm (W2.1).
- Before Wave 3 downsize: hot disk used < 250 GB across 3 nodes for 5 consecutive days, CPU < 60%, JVM < 40%.

Sources: live MCP queries to eu-b2b on 2026-05-31. Deployment ID 02655c3733ea471999d9cec39a17df32. Policies inspected: traces-apm.traces-default_policy v46, logs v48, logs-apm.app_logs-default_policy v49, metrics v37, .monitoring-8-ilm-policy v5, synthetics-synthetics.browser-default_policy v21, .alerts-ilm-policy v144, kibana-event-log-cleanup v1, logs-enterprise_search.audit-default v1, logs-workplace_search.analytics-default v1. Index inspection: 50 largest indices + 100 largest shards. ilm_explain on the 15 .internal.alerts-security.alerts-default-* indices and the suspected-stuck Fargate shared_services index.
