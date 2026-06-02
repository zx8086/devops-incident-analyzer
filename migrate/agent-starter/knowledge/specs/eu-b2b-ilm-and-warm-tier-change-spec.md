**eu-b2b ILM Retention and Warm Tier Change Spec**

*Implementation specification for IaC team · No commits made ·
2026-05-13*

**0. Scope and status**

Four changes are specified in this document. None has been applied. The
IaC team owns the Terraform commits; this document captures the exact
target state, pre-state taken from the live cluster on 2026-05-13,
validation queries, and rollback steps.

  -------- ---------------------------------------------------------------- ------------ --------------------------------------------------------------- -------------
  **\#**   **Change**                                                       **Type**     **Signoff status**                                              **Section**
  1        synthetics policy delete.min\_age 90d → 45d (or 30d)             ILM          Synthetics owner --- to confirm 45d vs 30d preference           §2
  2        logs-apm.error\_logs-default\_policy delete.min\_age 60d → 45d   ILM          APM consumer --- low-risk alignment with raw trace retention    §3
  3        traces-apm.traces-default\_policy delete.min\_age 45d → 30d      ILM          APM consumer --- gated, do not apply until explicit approval    §4
  4        Warm tier resize 2 GB → 8 GB per node (both zones)               Cloud plan   Platform --- pre-authorised on tracker row 33, Pending status   §5
  -------- ---------------------------------------------------------------- ------------ --------------------------------------------------------------- -------------

*Out of scope for this spec: APM aggregate retention 30d → 14--21d. The
user is checking with the business on aggregate query patterns before
specifying. See companion doc
eu-b2b\_Active\_Policy\_Optimisation\_2026-05-13.docx §2.3 for context.*

**1. Common pattern for all three ILM changes**

All three policies are currently fully managed by the
lifecycle\_policies Terraform module. The change in each case is a
single field in the corresponding JSON config --- the policy phase
bodies are otherwise preserved verbatim. After Terraform apply, expect:

-   Policy version increments by 1 (Elasticsearch behaviour, not driven
    by TF).

-   modified\_date matches apply timestamp.

-   retention\_days field on \_ilm/policy response recalculates from the
    new delete.min\_age (Elastic-computed, read-only).

-   All other phase configuration unchanged.

-   Cluster health stays green --- these are policy edits, not data
    moves; ILM acts on the new threshold at the next 10-minute poll.

*This mirrors the apply pattern used on us-cld for
traces-apm.rum\_traces-default\_policy on 2026-05-10, recorded in
Session\_Implementation\_Record\_May10\_2026.docx --- same change shape,
different policy.*

**2. Change 1 --- synthetics retention 90d → 45d (or 30d)**

**2.1 Pre-state (captured 2026-05-13)**

  ------------------ -----------------------------------------------------------
  **Field**          **Value**
  Policy name        synthetics
  Version            6
  Modified date      2026-04-21T06:04:53.653Z
  Retention (days)   90
  Phases             hot → warm (3d) → cold (7d) → frozen (14d) → delete (90d)
  Hot rollover       max\_age: 4d, max\_primary\_shard\_size: 50gb
  Active indices     24
  ------------------ -----------------------------------------------------------

**2.2 Target state --- option A: 45d**

Same as us-cld RUM edit pattern: only delete.min\_age changes. All other
phase bodies sent verbatim.

\"delete\": {

\"min\_age\": \"45d\",

\"actions\": { \"delete\": { \"delete\_searchable\_snapshot\": true } }

}

**2.3 Target state --- option B: 30d**

Same edit, different value.

\"delete\": {

\"min\_age\": \"30d\",

\"actions\": { \"delete\": { \"delete\_searchable\_snapshot\": true } }

}

*Recommendation: confirm with synthetics owner whether 45 or 30 days. 30
days saves more (cuts 60 days of frozen-tier storage instead of 45
days), but loses the full SLO breach forensics window for older
incidents. Both options are safe to apply --- searchable snapshots are
deleted with the index via delete\_searchable\_snapshot: true.*

**2.4 Terraform change**

Single-line edit in the lifecycle-policies JSON config under the policy
key \'synthetics\':

// environments/eu-b2b/lifecycle-policies/synthetics.json (or equivalent
path)

{

\"delete\": {

\"min\_age\": \"45d\" // was \"90d\"

}

}

Then:

make lifecycle-policies-init DEPLOYMENT=eu-b2b

make lifecycle-policies-plan DEPLOYMENT=eu-b2b

\# expect a single-resource diff on
module.lifecycle\_policies.elasticstack\_elasticsearch\_index\_lifecycle.this\[\"synthetics\"\]

make lifecycle-policies-apply DEPLOYMENT=eu-b2b

**2.5 Validation queries**

GET /\_ilm/policy/synthetics

// expect: version 7, modified\_date matches apply timestamp,
delete.min\_age = \"45d\" (or \"30d\")

GET /\_ilm/explain/.ds-synthetics-\*?only\_managed=true

// expect: all backing indices show policy: \"synthetics\" with no
errors

GET /\_ilm/explain/.ds-synthetics-\*?only\_errors=true

// expect: empty response (no ILM errors introduced)

**2.6 Rollback**

Re-set delete.min\_age back to 90d via the same TF edit. Existing
indices that were already deleted under the tighter retention cannot be
recovered --- they were deleted from cold/frozen tiers with
delete\_searchable\_snapshot: true. Snapshot data is gone.

**3. Change 2 --- logs-apm.error\_logs retention 60d → 45d**

**3.1 Pre-state (captured 2026-05-13)**

  ------------------ -----------------------------------------------------------
  **Field**          **Value**
  Policy name        logs-apm.error\_logs-default\_policy
  Version            21
  Modified date      2026-05-06T10:06:05.171Z
  Retention (days)   60
  Phases             hot → warm (3d) → cold (7d) → frozen (14d) → delete (60d)
  Hot rollover       max\_age: 7d, max\_primary\_shard\_size: 30gb
  Active indices     10
  ------------------ -----------------------------------------------------------

**3.2 Target state**

Align with traces-apm.traces (45d) so error-log retention does not
outlive the trace context. Only delete.min\_age changes.

\"delete\": {

\"min\_age\": \"45d\",

\"actions\": { \"delete\": { \"delete\_searchable\_snapshot\": true } }

}

**3.3 Terraform change**

//
environments/eu-b2b/lifecycle-policies/logs-apm.error\_logs-default\_policy.json
(or equivalent)

{

\"delete\": {

\"min\_age\": \"45d\" // was \"60d\"

}

}

**3.4 Validation queries**

GET /\_ilm/policy/logs-apm.error\_logs-default\_policy

// expect: version 22, delete.min\_age = \"45d\"

GET /\_ilm/explain/.ds-logs-apm.error-default-\*?only\_managed=true

// expect: all backing indices report policy with no errors

**3.5 Rollback**

Re-set delete.min\_age to 60d. Same caveat: indices already deleted
under 45d are unrecoverable.

**4. Change 3 --- traces-apm.traces retention 45d → 30d (signoff
gated)**

**DO NOT APPLY this change without explicit APM consumer signoff.** This
is the largest single-stream change in the spec. APM consumers may rely
on \>30d trace retention for incident retrospectives or audit. The May
10 us-cld RUM change deferred a comparable \'shared policy\' edit to a
\'wider stakeholder loop\' --- the same gate applies here.

**4.1 Pre-state (captured 2026-05-13)**

  ------------------ -----------------------------------------------------------
  **Field**          **Value**
  Policy name        traces-apm.traces-default\_policy
  Version            44
  Modified date      2026-04-21T06:06:04.236Z
  Retention (days)   45
  Phases             hot → warm (3d) → cold (7d) → frozen (14d) → delete (45d)
  Hot rollover       max\_age: 1d, max\_primary\_shard\_size: 50gb
  Active indices     46 ← largest active APM stream by index count
  ------------------ -----------------------------------------------------------

**4.2 Target state**

\"delete\": {

\"min\_age\": \"30d\",

\"actions\": { \"delete\": { \"delete\_searchable\_snapshot\": true } }

}

**4.3 Terraform change**

//
environments/eu-b2b/lifecycle-policies/traces-apm.traces-default\_policy.json
(or equivalent)

{

\"delete\": {

\"min\_age\": \"30d\" // was \"45d\"

}

}

**4.4 Pre-apply consumer signoff items**

-   Confirm no APM consumer (Observability team, app teams, audit) has a
    documented requirement for \>30d trace retention on eu-b2b.

-   Confirm with security/compliance whether trace retention is bound to
    any regulatory window --- if yes, 30d may be below the floor.

-   Confirm Kibana APM views (last 30d / Anomaly Detection / Service
    Maps) still function with 30d; longer historical comparisons in
    Kibana APM dashboards may break.

-   Capture written approval from at least one APM consumer owner before
    apply. The May 10 us-cld pattern recorded apply timestamp and
    approving party in the implementation record --- same here.

**4.5 Validation queries**

GET /\_ilm/policy/traces-apm.traces-default\_policy

// expect: version 45, delete.min\_age = \"30d\"

GET /\_ilm/explain/.ds-traces-apm.traces-default-\*?only\_managed=true

// expect: 46 indices reporting policy without error

GET
/\_cat/indices/.ds-traces-apm.traces-default-\*?v&s=index&h=index,creation.date.string,store.size

// note current oldest index; after ILM sweep, oldest should be \~30d
not \~45d

**4.6 Rollback**

Re-set delete.min\_age to 45d. Critical caveat: indices in the 30--45
day age band will have been deleted between apply and rollback. Those
days of trace history are unrecoverable. If rollback is required, also
document which days were lost in the implementation record.

**5. Change 4 --- Warm tier resize 2 GB → 8 GB per node**

**5.1 Pre-state (captured 2026-05-13)**

  ------------------------- ----------------------------------------------------------------------------------------------------------
  **Field**                 **Value**
  Deployment                eu-b2b (71bdf337bb454d7ba192142d5a9925cf)
  Region                    AWS eu-central-1 (Frankfurt)
  Tier                      data\_warm
  Instance config           aws.es.datawarm.d3-v1
  Current per node          RAM 2 GB · Disk 380 GB · 2 zones (eu-central-1a, 1b)
  Current per-tier RAM      4 GB total (2 nodes × 2 GB)
  Live JVM (per AutoOps)    81% --- above safe operating threshold
  Live system memory        78% --- above safe operating threshold
  Live storage allocation   29% (≈110 GB of 380 GB) per node --- disk is fine, memory is the constraint
  Tracker entry             row 33: \'Warm node resize 2GB → 8GB (cost increase)\' --- Status Pending, owner Platform, timeline ASAP
  ------------------------- ----------------------------------------------------------------------------------------------------------

**5.2 Target state**

  --------------------- -----------------------------------------------------------------------
  **Field**             **Value**
  Instance config       aws.es.datawarm.d3-v1 (unchanged)
  Target per node       RAM 8 GB · Disk 1520 GB (d3 family RAM:disk ratio scales 4× with RAM)
  Target per-tier RAM   16 GB total (2 nodes × 8 GB)
  Zone count            2 (unchanged)
  --------------------- -----------------------------------------------------------------------

*Confirm the disk scaling ratio with the EC console plan editor before
apply --- d3 family bundles RAM and disk per instance type, and the
exact RAM:disk pairing at the 8 GB tier should be read from the console
rather than assumed.*

**5.3 Terraform change**

Cloud plan resource. The Elastic Cloud Terraform module shape varies
(ec\_deployment or elasticstack\_elasticsearch\_cloud); adapt to your
repo\'s convention. The conceptual change:

// environments/eu-b2b/deployment/main.tf (or equivalent)

topology {

id = \"warm\_content\"

size = \"8g\" // was \"2g\"

size\_resource = \"memory\"

zone\_count = 2 // unchanged

// if autoscaling enabled, also raise:

autoscaling { max\_size = \"8g\" /\* or higher \*/ }

}

**Apply order matters:** if autoscaling is enabled on the warm tier, the
Elastic Cloud console validation enforces Max ≥ Current at every step.
For an upsize, raise the autoscaling Maximum first (separate TF apply or
single-resource targeted apply), then raise Current. The downsize order
is the reverse (Current first, then Max) --- confirmed pattern in our
previous resize work.

**5.4 Pre-apply checks**

-   Confirm cluster health green: GET \_cluster/health

-   Capture warm-tier baseline metrics: nodes\_stats jvm/fs/breaker on
    warm nodes

-   Confirm no ILM operations in flight on warm tier: GET
    \_ilm/explain/\*?only\_managed=true&filter\_path=indices.\*.phase →
    expect no warm phase shown as \'attempting\' or \'failed\'

-   Confirm no in-progress shard relocations: GET
    \_cluster/health?level=shards \| filter for \'relocating\_shards\' =
    0

**5.5 Apply behaviour**

Rolling restart on the two warm nodes --- one at a time. Standard EC
operation. Expected wall-clock duration: 15--30 minutes for both nodes.
During the restart of one warm node, shards that node holds become
temporarily unavailable; ILM and search-coordinated requests handle this
transparently. Cluster status briefly yellow (one node\'s shards
unallocated), returns to green when the resized node rejoins.

**5.6 Validation queries**

GET \_cluster/health

// expect: green, 0 unassigned shards (after both nodes complete)

GET
/\_nodes/data\_warm:true/stats?filter\_path=nodes.\*.name,nodes.\*.roles,nodes.\*.jvm.mem.heap\_max\_in\_bytes,nodes.\*.jvm.mem.heap\_used\_percent,nodes.\*.os.mem.used\_percent

// expect: heap\_max\_in\_bytes \~= 4 GB on 8 GB nodes (Elasticsearch
reserves half RAM for heap by default)

// heap\_used\_percent should drop substantially from \~81% pre-resize

GET /\_nodes/data\_warm:true/stats/breaker

// expect: parent breaker limit\_size proportional to 4 GB heap;
estimated\_size well below limit

\# AutoOps check: post-apply, the warm-tier \'High system memory\' alert
should clear within 1 hour.

**5.7 Hold period**

24-hour observation window after the second warm node rejoins. Watch:

-   Warm-tier JVM stays \<60% under normal load.

-   Warm-tier system memory \<80%.

-   No new AutoOps alerts on warm tier.

-   GC count delta over 24h \<20 per warm node.

**5.8 Rollback**

Revert the topology size back to 2g and apply. Same rolling-restart
behaviour in reverse. No data loss. Note this reintroduces the OOM
condition the resize was designed to fix.

**6. Net cost analysis**

Cost numbers below are estimates expressed as annualised ranges in EUR.
Actual figures depend on your Elastic Cloud contract pricing,
eu-central-1 list rates, and the share of total cluster storage each
policy represents. Assumptions are stated explicitly so you can plug
your own numbers in.

**6.1 Cost components**

  ------------------------------------------------------ --------------- --------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Change**                                             **Direction**   **Estimate / yr**     **Assumption / basis**
  Warm resize 2 → 8 GB × 2 nodes                         Cost +          +€5,000 to +€10,000   d3 family pricing scales ≈ linearly with RAM; 4× RAM on 2 nodes. Cross-reference Path B doc cost estimate band.
  Synthetics 90d → 45d                                   Cost −          −€1,000 to −€3,000    76d of post-frozen retention drops to 31d. Savings mostly on frozen S3 (cheap tier). Assumes synthetics ≈ 5--15% of total cluster storage.
  Synthetics 90d → 30d (alt)                             Cost −          −€2,000 to −€5,000    76d post-frozen retention drops to 16d, plus 7d shaved off cold. Larger saving than 45d option.
  error\_logs 60d → 45d                                  Cost −          −€500 to −€1,500      15d cut, mostly frozen-tier S3. Stream is smaller (10 indices) than traces or synthetics.
  traces-apm.traces 45d → 30d                            Cost −          −€3,000 to −€8,000    Largest active APM stream (46 indices). 15d cut, mostly frozen but also some cold. Signoff-gated.
  Frozen-phase add (free-standing)                       ≈ neutral       −€500 to +€500        Migrates \~120 indices from cold NVMe to S3 at 14d. S3 cheaper than NVMe; net near-zero immediately. Real value is downstream (next row).
  Cold tier downsize 380 → 190 GB / zone (conditional)   Cost −          −€2,400 to −€4,800    Path B estimate. Only viable once frozen-phase has moved data off cold and cold tier sits ≤ 40% disk fill. Earliest plausible: 30--45 days after change set is applied.
  ------------------------------------------------------ --------------- --------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**6.2 Net by scenario**

Three columns: most-favorable case (sums the most-savings end of each
line item with the lowest-cost end of the warm resize), least-favorable
case (the opposite), and midpoint (average of the two bands per item).
Positive = added cost, negative = saving.

  ---------------------------------------------------------------- -------------------- -------------- ---------------------
  **Scenario**                                                     **Most favorable**   **Midpoint**   **Least favorable**
  Stability-only: warm resize only (no retention edits)            +€5,000              +€7,500        +€10,000
  Items 1 (45d) + 2 + warm resize                                  +€500                +€4,500        +€8,500
  Items 1 (45d) + 2 + warm + cold downsize (when frozen settles)   −€4,300              +€900          +€6,100
  **Items 1 (45d) + 2 + 3 + warm + cold downsize**                 **−€12,300**         **−€4,600**    **+€3,100**
  **Items 1 (30d aggressive) + 2 + 3 + warm + cold downsize**      **−€14,300**         **−€5,600**    **+€2,100**
  ---------------------------------------------------------------- -------------------- -------------- ---------------------

*Arithmetic: most-favorable = sum of lowest-cost / highest-saving end of
each line item; least-favorable = the opposite end; midpoint = mean of
the two. Net is the algebraic sum: warm-resize positive value plus
negative-sign savings.*

*Read: without item 3 (traces signoff), the change set is cost-positive
to roughly break-even (midpoint +€900 to +€4,500). With item 3, the
midpoint moves into clear net saving (−€4,600 to −€5,600). The
least-favorable column shows that even with all items, the change set
could land slightly cost-positive if storage volumes are below my
assumed shares --- measure with the \_cat/indices command in §6.3 before
relying on any number here.*

**6.3 Interpretation**

**Without item 3 (traces signoff):** the change set is approximately
cost-neutral to slightly cost-positive in the near term (\~+€3K to
+€8K/yr). The cold-tier downsize takes the net into break-even or modest
saving territory after 30--45 days. This is a stability-and-TCO
investment, not a bill-line reduction.

**With item 3 (traces signoff secured):** the change set crosses into
clear bill-line reduction (\~−€2K to −€9K/yr depending on synthetics
choice and where the actual storage volumes land). Item 3 is the lever
that flips this from a TCO investment into a P&L saving.

**Sensitivity:** the largest source of uncertainty is the actual storage
share of each policy in total cluster storage. To replace the assumed
ranges with measured values, capture the following before apply and
recompute:

GET
/\_cat/indices/.ds-synthetics-\*,.ds-logs-apm.error-default-\*,.ds-traces-apm.traces-default-\*?v&h=index,store.size,creation.date.string&s=index&bytes=gb

*Sum store.size per policy family. Multiply policy-share fraction by
your annual Elastic Cloud cost. That gives the per-policy storage cost
band; the retention edits\' savings scale linearly with the fraction of
retention reduced (e.g., synthetics 90 → 45d cuts the 14--90d frozen
band by 76 − 31 = 45/76 = 59% of that policy\'s frozen footprint).*

**7. Suggested sequencing**

  ---------- ----------------------------------------------------------------- ----------------- -------------------------------------------------------------------------------
  **Step**   **Action**                                                        **Wait**          **Gate / signoff**
  1          Warm tier resize 2 → 8 GB                                         24h soak          Pre-authorised on tracker row 33
  2          Synthetics retention edit (45d preferred, 30d if owner agrees)    ILM 10-min poll   Synthetics owner confirms target value
  3          logs-apm.error\_logs retention edit 60d → 45d                     ILM 10-min poll   APM consumer confirms (likely fast --- error logs alignment is uncontentious)
  4          traces-apm.traces 45d → 30d                                       ILM 10-min poll   APM consumer + audit/compliance signoff required (do not apply otherwise)
  5          Add frozen phase to 13 active policies (see companion doc §2.2)   48--72h settle    Platform
  6          Cold tier downsize 380 → 190 GB / zone                            ---               Re-baseline cold tier disk fill \<40% before applying
  ---------- ----------------------------------------------------------------- ----------------- -------------------------------------------------------------------------------

*Steps 2 and 3 can run in either order or in parallel --- they touch
independent policies. Step 4 is signoff-gated and may not run at all if
APM consumers reject. Step 6 depends on step 5 settling.*

**8. Implementation record (template for IaC team)**

After each apply, capture in the project folder using the May 10
pattern:

-   Change name, policy/tier touched, apply timestamp (UTC).

-   Pre/post policy version (or deployment plan version for tier
    resize).

-   Pre/post field that changed (delete.min\_age or topology.size).

-   Cluster health pre/post.

-   ILM error scan post (only\_errors=true expected empty).

-   Approver name and ticket/Slack reference for signoff-gated changes
    (items 3 and 4).

-   Any unexpected behaviour and how it was resolved.

**9. Out of scope**

-   APM aggregate retention (item 4 from earlier analysis) --- pending
    business confirmation on dashboard query patterns past 14d.

-   Rollover threshold consolidation on logs-aws and APM aggregates ---
    needs per-stream rate-of-change data. Tracker row 38.

-   12-policy APM aggregate consolidation into apm-aggregates-default
    --- companion-doc item; can be paired with frozen-phase add (step 5)
    or done separately.

-   Forcemerge+shrink stripping (Option B from the recommendation) ---
    not recommended given the warm resize is the agreed path.

-   Hot tier downsize --- depends on app-team ingestion work that is
    currently blocked.

*End of specification.*
