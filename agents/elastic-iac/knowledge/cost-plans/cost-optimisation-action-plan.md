# Cost Optimisation Action Plan — eu-cld / us-cld / ap-cld

**Compiled:** 2026-05-25 · **Basis:** Billing v2 MTD 2026-05-01→05-25 (org 58,333 ECU) + live cluster queries
**Companion to:** `Cluster_Health_ILM_Cost_Review.md`

The three biggest levers, sequenced quick-win → structural. Health and ILM are clean, so all of this is pure cost work — nothing here is availability-driven.

---

## LEVER 1 — us-cld Synthetics (fastest money, lowest risk)

### What's actually happening
- **87 distinct browser monitors** on us-cld. Live run-rate measured today: **25,684 browser test runs in 24h**.
- Per-monitor pattern (measured): **5-minute schedule × 3 locations ≈ 864 tests/day each**.
- The volume is overwhelmingly **third-party vendor status-page checks** — `paypal-amer-status`, `miro-{amer,apac,emea}-status`, `afterpay`, `kong`, `klarna`, `adyen`, `acquia`, `confluent-kafka`, `eshopworld`, `loqate`, `narvar`, `retailnext`, `salesforce-commerce/marketing`, and an **`antavo-*` family of 7+ near-identical monitors**.
- Locations span private DC agents (`DC NA1`, `DC NA2`) **and** Elastic-managed global locations (US East, US West, Canada East, Germany, Singapore).
- Separately, the **`synthetics-browser.network-e_commerce`** stream (the real `PVH PROD JOURNEY`) writes **~11 GB/day** of network-capture data — its own hot-tier storage cost.

> Reconciliation note: the billing line read **334,380 browser tests** for the 25-day period (period average ≈13.9k/day), but the *current* rate is ~25.7k/day. The gap means the monitor fleet was scaled up during the period (the `antavo-st*/us6/us7` cluster looks recent). The trajectory is rising, which strengthens the case to act now.

### Actions (three independent multipliers — they stack)

| # | Action | Mechanism | Est. impact | Risk | Owner |
|---|---|---|---|---|---|
| S1 | **Drop status-check frequency 5 min → 15 min** | Edit monitor schedule in Synthetics/Fleet | −66% runs on affected monitors | Very low — vendor status pages don't need 5-min granularity | Obs team |
| S2 | **Cut locations 3 → 1** for vendor-status monitors | Remove extra `locations` from monitor config | −66% on affected monitors | Very low — a vendor's global status page doesn't need 3 vantage points | Obs team |
| S3 | **Convert pure status-page checks from Browser → Lightweight HTTP** | Re-define `*-status` monitors as `http` monitors hitting the status JSON/health endpoint | Removes them from the **Browser** billing line entirely (HTTP is ~an order of magnitude cheaper and lighter) | Low — needs the right endpoint per vendor; lose screenshot/DOM but keep up/down + latency | Obs team |
| S4 | **Consolidate the `antavo-*` family** (7+ monitors) | Merge duplicates / parameterise | Fewer monitors × every run | Low | Obs team |
| S5 | **Disable network + screenshot capture** where not needed (esp. anything writing to `synthetics-browser.network-*`) | Monitor `screenshots: off`, throttle network capture | Cuts the ~11 GB/day hot-tier write | Low–med — reduces forensic detail on failures | Obs team |

**Realistic combined outcome:** S1+S2 alone cut the browser-test count ~70–85% on the status-monitor population; S3 moves them off the Browser SKU. Browser synthetics is ~**4,113 ECU MTD on us-cld** (~6,400 ECU org-wide incl. eu-onboarding + eu-cld), so this lever is worth roughly **3,000–4,000 ECU/period** with little risk.

**Validation before/after:** re-run the 24h count `synthetics-browser-*` summary-doc query (it returned 25,684 today) after the changes; target a step-change down. Confirm no loss of true alerting coverage by checking each converted monitor still reports up/down.

---

## LEVER 2 — us-cld `mulesoft-aggregations-prod-v6` (one-off reclaim + closes a register item)

### What's happening
- `mulesoft-aggregations-prod-v6` = **103.1 GB, single shard, 168,367,922 docs** — the hot-tier single-shard hot-spot already tracked in the register/memory.
- `mulesoft-aggregations-prod-v7` = **48.0 GB, identical 168,367,922 docs** → almost certainly a reindexed/recompressed replacement of v6.
- **No aliases exist** on these indices — consumers reference the index name **directly**, so the cutover is an application-config change (Mulesoft aggregation writer + any dashboards/queries), not an ES alias swap.

### Actions

| # | Action | Risk | Owner |
|---|---|---|---|
| M1 | **Confirm v6 is no longer written**: check whether v6 doc count is still growing (it's frozen-identical to v7 now) and confirm the aggregation pipeline + dashboards now point at `-v7`. | — | Mulesoft/ingest owner |
| M2 | Once confirmed, **delete `mulesoft-aggregations-prod-v6`** → reclaims ~103 GB hot-tier and removes the single-shard hot-spot. | Medium — destructive; do only after M1. Snapshot first. | You + ingest owner |
| M3 | Ensure v7 (and future) is **multi-shard** so the hot-spot doesn't reappear — this is the resharding fix from the register (reshard plan v1 was drafted, not executed). | Low | You |

**Impact:** ~103 GB hot reclaim + eliminates the hottest single shard on us-cld. Closes the standing us-cld register item.

---

## LEVER 3 — eu-cld oversharding (biggest spender, structural, phased)

### What's happening
- eu-cld is **54% of org spend (31,672 ECU MTD)**. Data tiers dominate: datahot 60GB 3AZ (~9,570 ECU), datafrozen (~8,538), warm (~1,838), cold (~1,506), masters (~1,276), plus 38.7 TB snapshot storage (~1,279).
- **4,438 non-system indices / 7,195 primary shards, yet the largest non-frozen index is just 33 MB.** Classic over-sharding: thousands of tiny shards inflate heap and pin tier capacity, which is what blocks downsizing.
- Coordinating-node **autoscaling thrash** — three coordinating m6gd.2 sizes billed in-period (~1,269 ECU combined).

### Actions

| # | Action | Mechanism | Risk | Owner |
|---|---|---|---|---|
| E1 | **Identify the worst-offending templates/data streams** (most shards vs least data) — next drill-down step, I can run this on request. | ILM explain + `_cat/shards` rollup by data stream | — | You + me |
| E2 | **Raise ILM rollover floor** (e.g. `max_primary_shard_size: 50gb` / `max_size`) so new backing indices stop rolling over tiny. | `@custom` component templates (durable, survives rollover — per the Layer-2 approach in memory) | Low | You (Terraform/IaC) |
| E3 | **Shrink + force-merge** existing over-sharded warm/cold indices; reduce primary count on low-volume templates to 1. | ILM `shrink` / one-off `_shrink` | Med — test on non-prod template first | You |
| E4 | **Right-size coordinating tier** to stop autoscale flapping between 4/8/15 GB. | Set min=max (or narrower band) on the coordinating tier | Low | You (console/IaC) |
| E5 | After shard count drops and heap frees up, **downsize hot/warm/cold per-zone size**. | Reduce *Current size per zone first, then Maximum* (per memory: Max-first fails validation) | Med | You |

**Impact:** largest potential saving of the three, but it's structural and phased — E2/E4 are safe near-term wins; E3/E5 follow once sharding is under control. Realistic target after a full pass: a meaningful chunk of the ~13k ECU/period eu-cld hot+warm+cold spend.

---

## LEVER 4 (minor) — ML tiers

The recurring ML cost is on **us-cld**: a 4 GB ML tier billed full-period (~344 ECU/period ≈ ~$5.2k/yr). **This is already tracked** (Optimisation Tracker row 12, "us-cld ML node removal (if unused)") — action remains: confirm no active ML jobs, then remove. **ap-cld** ML is *negligible* — the 4 GB ML node ran only ~24h in the period (~10 ECU) and the 1 GB node bills at rate 0; not worth a separate action. eu-b2b also runs a 4 GB ML tier (~469 ECU/period) — confirm usage there too if pursuing.

---

## Suggested order of execution

1. **S1 + S2** — synthetics frequency + locations. Hours of config work, ~70–85% cut on the status-monitor volume, near-zero risk. **Do first.**
2. **M1 → M2** — confirm + delete mulesoft v6 (103 GB, closes register item). Gated on owner confirmation.
3. **S3 + S4** — convert status checks to lightweight HTTP, consolidate antavo. Bigger structural synthetics win.
4. **E2 + E4** — eu-cld ILM rollover floor + coordinating right-size (safe IaC changes).
5. **E1 → E3 → E5** — eu-cld shard reduction then tier downsize (phased, test on non-prod first).
6. **L4** — confirm + remove us-cld ML tier (already tracked, row 12); eu-b2b ML if pursuing. (ap-cld ML negligible — no action.)

All figures are ECU for the 2026-05-01→05-25 window; validate each change against a before/after billing pull and (for synthetics) the 24h run-count query.
