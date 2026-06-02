# 8. Operational governance

Source: Elastic_Optimisation_Playbook_v12 §8 (reference content).

## §8.1 Policy change register

--------------------------

Every ILM policy change must be recorded. A lightweight table in the
cluster's session handover does the job:

  **Field**            **Required**   **Example**
  -------------------- -------------- -------------------------------------------------
  Date/time            Yes            2026-04-21 14:30 UTC
  Cluster              Yes            eu-b2b
  Policy name          Yes            pathb-uniform-4tier
  Change summary       Yes            frozen min_age 30d → 14d
  Reason               Yes            cold tier 87% → target 70%
  Baseline reference   Yes            git: policies/pathb-uniform-4tier.json\@a3c1f92
  Rollback plan        Yes            Revert JSON, PUT _ilm/policy/...
  Validation window    Yes            48h watch on GET _autoscaling/capacity

## §8.2 APM-bundled policy auto-revert monitoring

---------------------------------------------

Risk: APM integration ships its own ILM policies. A Fleet package update
can silently replace the custom versions on the APM data streams.

## §8.2.1 Detect

# Compare current APM policies against baseline snapshot in git
    GET _ilm/policy/traces-apm.traces-default_policy
    GET _ilm/policy/metrics-apm.internal-default_policy
    GET _ilm/policy/logs-apm.app_logs-default_policy

## §8.2.2 Prevent

-   Override the default policy via index template: create a custom
    template that matches traces-apm.* with a higher priority (100+)
    pointing to the custom policy.

-   Weekly scheduled diff job (Kibana alert via Painless script) that
    compares the current policy JSON against git baseline and pages on
    drift.

-   Pin the APM integration version in Fleet --- do not auto-upgrade;
    upgrade in a planned window with revalidation.

## §8.3 Retention audit process
_Promoted to skill `skills/retention-audit-process/`._

## §8.3.1 Scope

-   Top 6 retention policies by index count cover 21,300 indices on
    eu-cld --- audit these first.

-   Any policy with delete min_age \>90d needs an explicit business
    justification.

-   Any policy with delete min_age \<14d should be double-checked ---
    is it really low-value or did someone set it wrong?

## §8.3.2 Steps

-   Pull retention requirement from data owner (SLA, regulation,
    analytics need).

-   Pull actual query pattern on data older than 30d --- Kibana search
    activity, APIM logs to _search.

-   If regulatory: document the regulation, cite it in policy
    description.

-   If no regulatory or query pattern supports \>30d: propose delete
    min_age reduction in the policy change register.

-   Give data owner 2-week comment window before applying.

## §8.4 Release gates

-----------------

Before any upgrade on an Elastic cluster:

-   Snapshot current policies to git (all custom + APM-bundled).

-   Record current shard count, index count, docs count --- baseline for
    post-upgrade comparison.

-   Confirm autoscaling ceilings will survive a reshuffle (temp disk
    pressure often higher during upgrade).

-   Read Elastic release notes specifically for ILM and built-in policy
    changes.

-   Run §3.4 immediately post-upgrade.

## §8.5 Handover live-verification step

-----------------------------------

Every session handover document must include a live-verification
appendix. Narrative handovers drift from reality fast: a change recorded
as 'applied' may have partially rolled back, or a policy cited in the
handover may have been silently replaced by a Fleet package update. The
only reliable record is a point-in-time API snapshot attached to the
handover.

-   Run the following commands at handover time and attach output
    verbatim:

```{=html}
<!-- -->
```
    GET _cluster/health
    GET _cat/indices?v&h=index,ilm.policy,docs.count,store.size
    GET _ilm/policy (all custom policies)
    GET _autoscaling/capacity
    GET _fleet/agent_policies (or Fleet UI export)
    GET _cat/allocation?v

-   The attached output is the handover's evidence, not the narrative.
    If narrative and evidence disagree, the evidence wins.

-   Receiver (next on-call or next session) re-runs the same commands on
    arrival and diffs against the attached output. Any discrepancy is
    the first thing to investigate.

-   Keep the output inside the handover file (or as a sibling export
    named _verification.txt). A handover without verification output is
    incomplete.

## §8.6 AutoOps event lifecycle as a closing signal

-----------------------------------------------

AutoOps Open Events serve as the canonical "is the work done" signal for
cluster-shape issues. When a fix is applied, the event clears on its own
once the cluster state no longer matches the rule. Use this property:

-   Treat each AutoOps event as a tracked deliverable. The event
    clearing is the verification.

-   For events with long tails (shards-per-node violations, max_shards
    override), expect 30--90 days for the underlying state to settle.
    Document the expected closure window in the change register.

-   For events that should clear within hours (Status Red, Data Node
    Disconnected), if they do not clear, escalate.

-   AutoOps Template Optimizer recommendations are first-class debt ---
    work the list down as part of regular hygiene (§6.1).

