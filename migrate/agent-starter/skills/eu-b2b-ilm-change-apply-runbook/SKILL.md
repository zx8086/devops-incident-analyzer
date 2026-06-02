---
name: eu-b2b-ilm-change-apply-runbook
description: Apply runbook for eu-b2b ILM retention + warm/cold tier resize package — compressed multi-day timeline with gates between phases.
inputs:
  cluster: { type: string, required: true, default: eu-b2b }
outputs:
  status: { type: string }
---

**eu-b2b ILM Change --- Approval & Apply Runbook**

*Compressed apply schedule · Signoff captured · 2026-05-13*

**1. Approval state**

Full package approved for apply: items 1 + 2 + 3 + warm resize + cold
downsize. Net cost outlook (midpoint): −€4,600/yr; most-favorable:
−€12,300/yr; least-favorable: +€3,100/yr. Full sensitivity analysis is
in §6 of eu-b2b\_ILM\_and\_Warm\_Tier\_Change\_Spec\_2026-05-13.docx
(the spec doc); this runbook covers the apply mechanics only.

  -------- --------------------------------- ------------------------------------------------- ----------------------------------------------------------
  **\#**   **Change**                        **Owner of approval**                             **Approval status**
  1        synthetics 90d → 45d              Synthetics owner                                  Approved (covered under package decision 2026-05-13)
  2        logs-apm.error\_logs 60d → 45d    APM consumer                                      Approved 2026-05-13
  3        traces-apm.traces 45d → 30d       APM consumer + audit/compliance                   Approved 2026-05-13 (the previously gated item)
  4        Warm tier 2 GB → 8 GB × 2 nodes   Platform                                          Approved (tracker row 33, pre-existing)
  5        Cold tier 380 → 190 GB / zone     Platform (conditional on cold-fill measurement)   Approved Day 4, gated on disk fill \<40% post-frozen-add
  -------- --------------------------------- ------------------------------------------------- ----------------------------------------------------------

**Capture before apply:** the IaC team should record the exact approver
name(s) and ticket/Slack reference for items 1, 2, 3 in the
implementation log (§5 of this runbook). The May 10 us-cld
implementation record set the precedent --- same fields populated here.

**2. Compressed timeline**

  ----------- ---------------------------- ------------------------------------------------------------------------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------
  **Day**     **Window**                   **Action**                                                                                                                                                    **Gate to next step**
  **0**       Morning                      Warm tier resize 2 → 8 GB per node (both zones). Rolling restart \~30 min.                                                                                    Cluster green; warm JVM ≤ 50%; no new AutoOps alerts on warm
  **0**       Afternoon (warm green ≥4h)   TF apply items 1, 2, 3 retention edits + add frozen { min\_age: 14d } to the 13 active policies missing it (see spec doc §2.2 / companion analysis doc).      All four/thirteen policies show version+1, modified\_date matches apply, no ILM errors
  **0--1**    Overnight                    ILM polls every 10 min. New retention thresholds activate. Existing \>14d-old aggregate indices begin transitioning cold → frozen via searchable\_snapshot.   Searchable-snapshot operations complete (visible as \'partial-\' prefix indices in \_cat/indices)
  **2--3**    Daytime                      Re-measure cold tier disk fill and JVM. Re-measure storage volumes per policy.                                                                                Cold disk fill \<40%; cold JVM trending \<60%
  **4**       Morning                      Cold tier downsize 380 → 190 GB / zone. Apply order: Current per zone first, then Maximum (per existing memory note on downsize order). Rolling restart.      Cluster green; cold disk fill stable; no new AutoOps alerts
  **4--11**   One-week soak                Watch AutoOps for any regression. Capture \_cat/indices?bytes=gb post-apply to compute realised storage savings.                                              Close the change set with measured-savings line on the tracker
  ----------- ---------------------------- ------------------------------------------------------------------------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------

**If any gate fails:** halt and triage before proceeding. Each gate is a
checkpoint --- do not collapse them. The compressed schedule still
requires every checkpoint to pass.

**3. Apply commands (in order)**

**3.1 Day 0 morning --- warm resize**

Adjust the warm tier topology in the eu-b2b deployment TF stack. If
autoscaling is enabled, the apply needs Maximum raised before Current
can be raised --- split into two targeted applies if your TF setup
requires.

\# environments/eu-b2b/deployment/ (or equivalent)

\# Edit warm topology size from 2g → 8g; keep zone\_count = 2

terraform plan -target=module.cluster.ec\_deployment.this

terraform apply -target=module.cluster.ec\_deployment.this

Post-apply checks before continuing to afternoon work:

GET \_cluster/health \# expect green, 0 unassigned

GET
\_nodes/data\_warm:true/stats?filter\_path=nodes.\*.name,nodes.\*.jvm.mem

\# heap\_max\_in\_bytes \~= 4 GB (half of 8 GB) per warm node

\# heap\_used\_percent should be well below the 81% pre-resize

**3.2 Day 0 afternoon --- ILM edits in one TF apply**

Edit the four lifecycle-policy JSON configs (or whichever pattern your
repo uses) and add the frozen phase to the 13 active policies that lack
it.

\# environments/eu-b2b/lifecycle-policies/

\# synthetics.json → delete.min\_age \"90d\" → \"45d\"

\# logs-apm.error\_logs-default\_policy.json → delete.min\_age \"60d\" →
\"45d\"

\# traces-apm.traces-default\_policy.json → delete.min\_age \"45d\" →
\"30d\"

\# 13 × policies → add frozen { min\_age: \"14d\" } phase

make lifecycle-policies-init DEPLOYMENT=eu-b2b

make lifecycle-policies-plan DEPLOYMENT=eu-b2b

\# expect 16 resource diffs (3 retention edits + 13 frozen-phase adds)

make lifecycle-policies-apply DEPLOYMENT=eu-b2b

make deploy-validate DEPLOYMENT=eu-b2b \# cluster green check

Verify the three retention edits actually landed:

GET
\_ilm/policy/synthetics,logs-apm.error\_logs-default\_policy,traces-apm.traces-default\_policy

\# synthetics: version 7, delete.min\_age \"45d\"

\# logs-apm.error\_logs-default\_policy: version 22, delete.min\_age
\"45d\"

\# traces-apm.traces-default\_policy: version 45, delete.min\_age
\"30d\"

And confirm frozen phase added to the 13 active policies:

GET
\_ilm/policy/metrics-apm.\*\_metrics-default\_policy,metrics-apm.internal\_metrics-default\_policy

\# each policy should now have a \'frozen\' phase with min\_age \"14d\"

**3.3 Day 0--1 --- ILM convergence**

No action. Watch ILM transition activity:

GET
\_ilm/explain/.ds-metrics-apm.\*?only\_managed=true&filter\_path=indices.\*.phase,indices.\*.policy

\# eligible indices \>14d age should transition phase: cold → frozen

GET \_ilm/explain/.ds-\*?only\_errors=true

\# expect: empty. If anything appears, halt and triage before Day 2.

GET \_cat/indices/partial-\*?v&s=index

\# partial-\* prefix = frozen searchable-snapshot. Should see new APM
aggregate entries appear over 24-72h.

**3.4 Day 2--3 --- re-measurement**

GET \_nodes/data\_cold:true/stats/fs

\# cold-tier disk fill: expect drop from \~61% toward \<40%

GET \_nodes/data\_cold:true/stats/jvm

\# cold-tier JVM: expect drop from \~79% toward \<60%

GET
\_cat/indices/.ds-synthetics-\*,.ds-logs-apm.error-default-\*,.ds-traces-apm.traces-default-\*?v&h=index,store.size,creation.date.string&s=index&bytes=gb

\# capture realised storage per policy; compute actual saving vs §6 spec
estimate

**3.5 Day 4 --- cold tier downsize**

Apply only if Day 2--3 measurement showed cold disk \<40%. Otherwise
extend convergence window.

\# environments/eu-b2b/deployment/

\# Edit cold topology size from 380g → 190g; keep zone\_count = 2

\# Apply order: Current per zone first, then Maximum (downsize
direction)

terraform plan -target=module.cluster.ec\_deployment.this

terraform apply -target=module.cluster.ec\_deployment.this

Post-apply checks:

GET \_cluster/health \# green, 0 unassigned

GET \_nodes/data\_cold:true/stats/fs \# disk fill should be \~70-80% on
the smaller tier (acceptable)

GET \_nodes/data\_cold:true/stats/jvm,breaker

**4. Rollback per step**

  ------------------ ---------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------------
  **Step**           **Rollback action**                                                                            **Data loss?**
  Warm resize        Revert size 8g → 2g in TF, apply. Rolling restart in reverse.                                  None
  synthetics 45d     delete.min\_age = \"90d\" in TF, apply.                                                        Days 45--90 already deleted (delete\_searchable\_snapshot: true) --- unrecoverable
  error\_logs 45d    delete.min\_age = \"60d\" in TF, apply.                                                        Days 45--60 deleted --- unrecoverable
  traces 30d         delete.min\_age = \"45d\" in TF, apply.                                                        Days 30--45 deleted --- unrecoverable. Capture which day-windows were lost in the impl log if rollback is required.
  Frozen-phase add   Remove frozen phase from the 13 policies in TF, apply. Indices already in frozen stay there.   None --- frozen indices remain accessible via searchable snapshot
  Cold downsize      Revert size 190g → 380g in TF, apply. Cold tier expands back.                                  None
  ------------------ ---------------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------------

**Key point:** retention reductions are irreversible past the new delete
threshold. The window between apply and any rollback decision is the
irrecoverable data window. Plan accordingly.

**5. Implementation log (fill in during apply)**

Save under the same project folder as
eu-b2b\_ILM\_Change\_Implementation\_Record\_\<date\>.md. Mirrors the
May 10 us-cld pattern.

**5.1 Header**

-   Cluster: eu-b2b (71bdf337bb454d7ba192142d5a9925cf), v9.4.0

-   Apply date: \_\_\_

-   Operator: \_\_\_

-   Approvers captured (item, name, channel/ticket, date):

    -   --- Synthetics owner for item 1: \_\_\_

    -   --- APM consumer for item 2: \_\_\_

    -   --- APM consumer for item 3: \_\_\_

    -   --- Audit/compliance for item 3: \_\_\_

**5.2 Step-by-step record**

For each step, capture:

-   Pre-apply timestamp (UTC) and the GET /\_cluster/health result.

-   TF plan output summary (resource counts, first-line diffs).

-   Apply timestamp (UTC) and apply result (acknowledged/error).

-   Post-apply validation result against the checks in §3.

-   Any unexpected behaviour observed and how it was resolved.

**5.3 Step 1 --- Warm resize**

  ----------------------------------------------- ---------------------------------------------------
  **Field**                                       **Value**
  Pre-apply timestamp (UTC)                       \_\_\_
  Pre-apply cluster health                        \_\_\_
  Pre-apply warm-tier JVM                         \_\_\_ (live screenshot 2026-05-13 baseline: 81%)
  Pre-apply warm-tier sys mem                     \_\_\_ (baseline: 78%)
  TF plan summary                                 \_\_\_
  Apply timestamp (UTC)                           \_\_\_
  Apply result                                    \_\_\_
  Post-apply heap\_max\_in\_bytes per warm node   \_\_\_ (expect \~4 GB)
  Post-apply warm-tier JVM                        \_\_\_ (expect \<60%)
  Post-apply warm-tier sys mem                    \_\_\_ (expect \<80%)
  Notes                                           \_\_\_
  ----------------------------------------------- ---------------------------------------------------

**5.4 Step 2 --- ILM edits + frozen-phase add**

  ------------------------------------------------------- ------------ ------------ --------------------
  **Field**                                               **Pre**      **Target**   **Post (fill in)**
  synthetics --- version                                  6            7            \_\_\_
  synthetics --- delete.min\_age                          90d          45d          \_\_\_
  synthetics --- modified\_date                           2026-04-21   apply ts     \_\_\_
  logs-apm.error\_logs --- version                        21           22           \_\_\_
  logs-apm.error\_logs --- delete.min\_age                60d          45d          \_\_\_
  traces-apm.traces --- version                           44           45           \_\_\_
  traces-apm.traces --- delete.min\_age                   45d          30d          \_\_\_
  Frozen-phase add --- \# policies edited                 0            13           \_\_\_
  ILM error count (any/\_ilm/explain?only\_errors=true)   0            0            \_\_\_
  Apply timestamp (UTC)                                   ---          ---          \_\_\_
  ------------------------------------------------------- ------------ ------------ --------------------

**5.5 Step 5 --- Cold tier downsize**

  -------------------------------- ----------------------- --------------------------- -------------------
  **Field**                        **Pre-frozen-settle**   **Pre-downsize**            **Post-downsize**
  Cold-tier disk fill %            61% (2026-05-13)        \_\_\_                      \_\_\_
  Cold-tier JVM %                  79% (2026-05-13)        \_\_\_                      \_\_\_
  Cold-tier size per zone          380 GB                  380 GB                      190 GB
  Cluster health                   green                   \_\_\_                      \_\_\_
  Apply timestamp (UTC)            ---                     ---                         \_\_\_
  Gate decision (proceed/extend)   ---                     \_\_\_ (proceed if \<40%)   ---
  -------------------------------- ----------------------- --------------------------- -------------------

**5.6 Realised saving (Day 11 close-out)**

-   Measured storage per policy via \_cat/indices?bytes=gb: \_\_\_

-   Cluster storage total pre-apply: \_\_\_ TB post-apply: \_\_\_ TB
    delta: \_\_\_ GB

-   Estimated annualised saving based on measured deltas and EC pricing:
    \_\_\_ EUR/yr

-   Variance vs spec midpoint (−€4,600): \_\_\_ EUR/yr \_\_\_
    (over/under)

-   Tracker rows to mark Resolved with realised numbers: r40, r41, r42,
    r43, r33, and Phase 4.5 rows 35--38 as appropriate

**6. Risk monitor during the change window**

Three risk surfaces to watch from Day 0 to Day 11:

  -------------------------------------------- ---------------------------------------------------------------------------------------- --------------------------------------------------------------------------------------------------------------------------------
  **Risk**                                     **Indicator**                                                                            **Halt threshold**
  Warm-tier resize complication                Cluster yellow \>30 min during rolling restart; warm node fails to join after restart    If any warm node fails to rejoin within 1h, halt afternoon work; investigate per Elastic Cloud support flow
  ILM error on retention edits or frozen-add   /\_ilm/explain?only\_errors=true returns non-empty for any of the 16 affected policies   Halt; classify error; if related to delete\_searchable\_snapshot, check snapshot repo health
  Frozen tier capacity                         Frozen S3 usage approaching ceiling (currently 2.52% of 1.18 TB, ample headroom)         If frozen S3 fill exceeds 50% during convergence, pause; revisit retention assumptions
  Heap pressure on hot tier                    Hot-tier searchable-snapshot operations during frozen-add may briefly raise hot heap     If parent breaker on hot \>70% sustained for \>10 min, pause frozen-add convergence by setting ILM\_POLL\_INTERVAL temporarily
  Cold downsize undersizing                    Post-downsize cold disk fill \>80%                                                       If cold disk \>80% after downsize, the 190 GB target was too aggressive --- revert to 380 GB and re-baseline
  -------------------------------------------- ---------------------------------------------------------------------------------------- --------------------------------------------------------------------------------------------------------------------------------

*The Phase 4 cluster-level breaker safety nets set on 2026-05-08
(request limit 40%, total.use\_real\_memory: true) remain in place ---
they protect against unexpected query-side memory events during this
work.*

**7. Out of scope for this runbook**

-   APM aggregate retention reduction (30d → 14--21d) --- pending
    business confirmation on dashboard query patterns. Not part of this
    package.

-   12-policy APM aggregate consolidation into apm-aggregates-default
    --- operational hygiene, can be done separately or paired with a
    future change set.

-   Rollover threshold consolidation on logs-aws and APM aggregates ---
    needs per-stream ingest rate data first.

-   Hot tier downsize --- gated on app-team ingestion reduction (Phase 4
    of optimisation tracker).

*End of runbook. Companion documents:
eu-b2b\_ILM\_and\_Warm\_Tier\_Change\_Spec\_2026-05-13.docx (full
design), eu-b2b\_Active\_Policy\_Optimisation\_2026-05-13.docx
(analysis), Elastic\_Optimisation\_Tracker\_May13\_2026\_v6.xlsx
(tracker with approved statuses).*
