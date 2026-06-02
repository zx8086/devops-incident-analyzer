**Elastic Cost-Optimisation --- App-Owner Action Brief**

*Updated 2026-05-26 (reindex started 03:44 UTC; Transform finding
logged) · Source: live cluster health/ILM checks + Elastic Cloud Billing
v2 (month-to-date 2026-05-01 to 2026-05-25). Supersedes prior brief ---
see Section D for actions already applied this update.*

Health and ILM are clean across eu-cld, ap-cld and us-cld --- all three
GREEN, 100% active shards, zero unassigned shards, zero ILM indices in
the ERROR step, and no ILM stragglers. Nothing here is
availability-driven; this brief lists cost-optimisation actions that
need an owning team to act.

Dollar figures use 1 ECU ≈ 1 US dollar at list price; apply the
committed-contract discount for the net amount. Canonical tracking:
Consolidated Issue Register v20, Elastic Optimisation Playbook v12
(sections 6.8.3, 7.6, 7.7), Elastic Optimisation Tracker v13.

Spend context (MTD, ECU ≈ \$ at list)

  ---------------- -------------- ----------- -------------------------------------------------------------------------
  **Deployment**   **MTD cost**   **Share**   **Note**
  eu-cld           31,672         54%         Largest spender; data tiers + over-sharding
  us-cld           13,384         23%         Synthetics + mulesoft hot-spot; hot-phase shortening applied 2026-05-26
  ap-cld           3,349          6%          Lean; no major action
  Org total        58,333         100%        ≈ \$58K/period · \~\$74K/mo · \~\$890K/yr at list
  ---------------- -------------- ----------- -------------------------------------------------------------------------

A. Observability / Synthetics team --- us-cld

Fastest, lowest-risk win. us-cld runs 87 browser monitors generating
\~25,684 browser test runs per 24h (measured 2026-05-25). The large
majority are vendor status-page checks (paypal, miro, afterpay, kong,
klarna, adyen, an antavo family of 7+, acquia, confluent, eshopworld,
loqate, narvar, retailnext, salesforce) running a 5-minute schedule
across 3 locations. Browser synthetics on us-cld is \~\$62K/yr at list.

  --------------------- ------------------------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------
  **Action**            **What we need from you**                                                                                     **Saving / risk**
  S1 --- Frequency      Raise status-check schedule from 5 min to 15 min.                                                             −66% on affected monitors. Very low risk.
  S2 --- Locations      Reduce status monitors from 3 locations to 1.                                                                 −66% on affected monitors. Very low risk.
  S3 --- Monitor type   Convert pure status-page checks from browser to lightweight HTTP monitors (hit the status/health endpoint).   Moves them off the Browser SKU (HTTP \~10x cheaper). Low risk; loses screenshot/DOM, keeps up-down + latency.
  S4 --- Consolidate    Merge the antavo-\* family (st1/st3/st4/st9/us6/us7/us-emea) into parameterised monitors.                     Fewer monitors × every run. Low risk.
  S5 --- Data capture   Disable network + screenshot capture where forensic detail is not needed.                                     Trims the \~11 GB/day synthetics-browser.network hot-tier write. Low--med risk.
  --------------------- ------------------------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------

**Combined expected saving: \~\$44--53K/yr (us-cld) at list. Validate
via the 24h synthetics-browser summary-doc count before/after.**

B. Mulesoft / ingest owner --- us-cld

UPDATE 2026-05-26: live \_count API shows mulesoft-aggregations-prod-v6
= 168,367,922 docs (single shard, 103 GB) and
mulesoft-aggregations-prod-v7 = 0 docs (empty 3-shard placeholder,
pre-configured for bulk load). The reshard plan was drafted but not
executed until today.

**KEY FINDING: the source Transform \`mulesoft-aggregations-prod-v6\`
has been stopped since 2026-03-22 02:11 UTC (last checkpoint 71299 in
.transform-internal-\*, 65 days with zero progress). v6 has been
effectively static for 65 days --- no live writes --- so the reindex is
safe without a write-pause window. Stack Monitoring is not enabled on
us-cld, which is why the stop went unnoticed.**

Reindex started 2026-05-26 03:44 UTC via MCP (task
HL9HiQQZRbCzOa8O5RoaGA:26376746, 5 slices in parallel, \~12k docs/sec,
ETA \~3.9h). v6 itself is left untouched until cutover.

  -------------------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- --------------------------------------------------------------------
  **Action**                       **What we need from you**                                                                                                                                                                                                              **Outcome**
  M1 --- Reindex (in flight)       Already running (started 03:44 UTC). No action from you while it runs. Platform will run a parity check (v7 count must equal 168,367,922, zero version conflicts) and re-enable refresh\_interval + replicas on v7 when it finishes.   v7 populated.
  M2 --- Transform decision        Decide: REVIVE the Transform with dest.index = v7 and \_start it (resumes the rollup against logs-mulesoft-na\_mulesoft\_prod), OR RETIRE it (delete Transform; rollup is permanently off).                                            Determines the cutover path.
  M3 --- Cutover (depends on M2)   If revive: confirm dashboards/queries point at v7. If retire: confirm no consumers still read from v6.                                                                                                                                 Safe to drop v6.
  M4 --- Reclaim                   Platform snapshots v6 then deletes it.                                                                                                                                                                                                 \~103 GB hot-tier reclaimed; closes the hot-spot. (Playbook §6.8.)
  -------------------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- --------------------------------------------------------------------

C. Platform / Infrastructure

eu-cld is 54% of org spend and is severely over-sharded: 4,438
non-system indices / 7,195 primary shards, yet the largest non-frozen
index is only 33 MB. Tiny shards inflate heap and pin tier capacity,
which is what blocks downsizing.

  ----------------------- ----------------------------------------------------------------------------------------------------------------------------------- ----------------------------------------------------------
  **Action**              **What we need from you**                                                                                                           **Saving / note**
  E1 --- Quantify         Rank templates/data streams by shards-vs-data to find the worst offenders (can be produced on request).                             Sizes the prize.
  E2 --- Rollover floor   Raise the ILM rollover floor via \@custom component templates so new backing indices stop rolling tiny.                             Safe near-term; durable.
  E3 --- Shrink           Shrink + force-merge over-sharded warm/cold indices; reduce primaries to 1 on low-volume templates.                                 Test on a non-prod template first.
  E4 --- Coordinating     Right-size the coordinating tier to stop autoscale flapping between 4/8/15 GB.                                                      \~1,269 ECU/period churn.
  E5 --- Downsize         After shard count drops and heap frees, reduce hot/warm/cold per-zone size (Current first, then Maximum).                           Sits on \~\$190K/yr base; 15--20% target ≈ \$30--40K/yr.
  ML --- Confirm/remove   Confirm no active ML jobs on us-cld 4 GB ML tier (already tracked) and eu-b2b 4 GB ML; remove if unused. ap-cld ML is negligible.   us-cld ML ≈ \$5.2K/yr.
  ----------------------- ----------------------------------------------------------------------------------------------------------------------------------- ----------------------------------------------------------

D. Already applied this update --- 2026-05-26

Hot-tier disk relief on us-cld via ILM warm.min\_age tuning. Trigger:
instance-0000000213 (zone-0) at 91% disk used and drifting \~30 GB/day,
persistent after the 2026-05-24 allocation-filter reroute. Applied via
Elastic MCP ilm\_put\_lifecycle at 03:29 UTC; ILM evaluates every \~10
min, so rolled-over indices that have been in hot more than 6h migrate
to warm on the next pass. Playbook §7.7.

  ---------------------------------------- ------------- ------------------- -----------------
  **Policy**                               **Indices**   **warm.min\_age**   **Now version**
  traces-apm.rum\_traces-default\_policy   816           1d → 6h             v6
  basic-lifecycle-logs                     4,086         1d → 6h             v13
  us-default-lifecycle-logs-prod           526           1d → 6h             v6
  basic-lifecycle-metrics                  1,415         1d → 6h             v17
  ---------------------------------------- ------------- ------------------- -----------------

Expected outcome: \~300--400 GB of hot tier freed as rolled indices
migrate. Trade-off: queries on \<1d data hit warm d3 disk (vs hot c6gd
SSD) --- usually fine for logs/traces, possibly noticeable for
interactive APM dashboards on yesterday\'s data. Rollback: one PUT per
policy restoring warm.min\_age = 1d.

Validation (Platform): re-check instance-0000000213 free space via GET
\_nodes/stats/fs in 30--60 min after 03:29 UTC; confirm a step-change
up. If insufficient, drop warm.min\_age to 0d.

Bottom line

\(A\) Synthetics --- biggest fast win; do first. (B) Mulesoft reindex
into v7 --- now reframed: the reshard has not run yet; v7 is empty. (C)
eu-cld oversharding --- biggest prize, structural, phased. (D) Today\'s
hot-phase change has already addressed the immediate us-cld alert; watch
disk to confirm.
