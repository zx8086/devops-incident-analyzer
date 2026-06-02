# Cluster Health, ILM & Cost Review — eu-cld / ap-cld / us-cld

**Check run:** 2026-05-25 · **Author:** Simon (with Claude session assistance)
**Source:** Live Elastic MCP — cluster health API, ILM explain API, Billing v2 API (MTD 2026-05-01 → 2026-05-25)

---

## 1. Cluster health — all GREEN

| Cluster | Status | Nodes (data) | Active primaries | Active shards | Unassigned | Relocating/Init | Pending tasks |
|---|---|---|---|---|---|---|---|
| eu-cld | **green** | 19 (12) | 7,195 | 9,365 | 0 | 0 / 0 | 0 |
| ap-cld | **green** | 16 (10) | 1,091 | 1,607 | 0 | 0 / 0 | 0 |
| us-cld | **green** | 20 (12) | 9,491 | 10,658 | 0 | 0 / 0 | 0 |

All three report `active_shards_percent = 100`, zero unassigned/relocating/initializing shards, and an empty pending-task queue. No availability concerns.

## 2. ILM — no errors, no stragglers

**Pending errors:** A cluster-wide ILM explain filtered to `onlyErrors` (uncapped, scans every managed index) returned **zero indices in the ERROR step on all three clusters.** No retries pending, no stuck-on-error policies.

**Stragglers by stage:** Managed-index state sampling (500 indices/cluster) shows every index sitting in a terminal `complete` state or the normal write-index `hot:rollover` wait. No indices wedged mid-action (shrink / migrate / searchable_snapshot / downsample / allocate).

One transitional index found and inspected:

| Cluster | Index | State | Age | Verdict |
|---|---|---|---|---|
| us-cld | `.ds-logs-sapbobj.generic-na_sapbobj_nonprod-2026.05.17-000570` | `warm:forcemerge` | 1d | In-flight force-merge, **not** errored. Transient. Recheck next pass — only a concern if still here. |

*Coverage note:* the error scan is complete (all indices). The straggler/state sampling covered the first 500 managed indices per cluster (of 873 ap-cld / 6,585 eu-cld / 8,988 us-cld) — the MCP tool caps output at 500 and has no offset, so this is a representative sample, not a full enumeration. The zero-error result is the authoritative "nothing is stuck" signal; combined with GREEN + 100% active shards, ILM is healthy.

## 3. Cost — MTD spend & optimisation opportunities

Org total month-to-date (May 1–25): **58,333 ECU.** Per the three clusters in scope:

| Deployment | ECU (MTD) | Share |
|---|---|---|
| eu-cld | 31,672 | 54% |
| us-cld | 13,384 | 23% |
| ap-cld | 3,349 | 6% |
| *(eu-b2b 7,017 · eu-onboarding 2,131 · gl-cld-reporting 638 · monitors+gl-testing ~142)* | | |

**eu-cld (largest spender — biggest lever):**
- Data-tier spend dominates: datahot c6gd 60GB 3AZ (~9,570 ECU), datafrozen i3en.2 tiers (~8,538 ECU combined), warm/cold i3en (~3,344 ECU), plus 38.7 TB snapshot storage (~1,279 ECU).
- **Severe oversharding.** 4,438 non-system indices / 7,195 primaries, yet the largest non-frozen index is only **33 MB**. Tiny shards inflate heap and pin tier capacity, blocking downsizing. Consolidating small data streams (raise rollover size, ILM shrink, fewer primaries per template) is the structural fix that would let the hot/warm tiers shrink.
- **Coordinating-node thrash:** three coordinating m6gd.2 sizes billed in-period (~1,269 ECU) from autoscaling churn — right-size to reduce flapping.

**us-cld:**
- **Synthetics Browser is the single biggest discretionary cost:** 334,380 browser tests ≈ **4,113 ECU**. Audit monitor frequency/count — small interval changes scale linearly.
- **`mulesoft-aggregations-prod-v6` (103 GB, 1 shard) vs `-prod-v7` (48 GB) hold the identical doc count (168,367,922).** v7 looks like the resharded/recompressed replacement. *If v7 is confirmed as the live target, dropping v6 reclaims ~103 GB of hot-tier and removes the single-shard hot-spot from the register.* Do not delete until the write alias / consumer cutover is verified.
- Two integrationsserver (APM) tiers (4GB + 8GB) churning ~554 ECU — consolidate to one size.

**ap-cld:** lean (6% of org). Only flag: a 4GB ML tier billed full-period (~344 ECU) plus brief 16GB ML spin-ups — confirm ML is actually used here, otherwise it's removable.

## 4. Cross-reference against the issue register

The current register (`issue-register-2026-05-17.md`) is the Fleet agent **binary-upgrade** session log; none of its open items (O1–O5, T1–T5, I1–I7, D1–D2) are cluster-health or ILM blockers for these three deployments. Item **D1** does flag that us-cld and eu-cld are pending Fleet *agent-version* inventory — separate from this data-plane review, still open.

Findings consistent with prior known state: the us-cld single-shard `mulesoft-aggregations-prod-v6` hot-spot and the us-cld cold/coord sizing remain the two named us-cld watch items.

## 5. Bottom line

Health and ILM are clean across eu-cld, ap-cld, and us-cld — GREEN, zero unassigned shards, zero ILM errors, no stuck stragglers (one transient force-merge to recheck). The cost story is concentrated in **eu-cld oversharding** (structural, highest-value fix) and **us-cld Synthetics + the v6/v7 mulesoft duplicate** (quick wins pending cutover confirmation).
