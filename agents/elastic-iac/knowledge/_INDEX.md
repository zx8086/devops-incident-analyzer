# Knowledge index

Every file under `knowledge/` and any new skills promoted from the source corpus, grouped by category.

## reference/ (foundational facts; the `reference` index.yaml category)

- `reference/iac-repo-map.md` — GitOps repo path/id + the environments/ vs stacks/ tree
- `reference/conventions.md` — local lore / standing gotchas
- `reference/cluster-inventory.md` — live cluster set + per-cluster notes
- `reference/stack-modules.md` — Terraform module map
- `reference/operating-guide.md` — canonical "start here" (verbatim copy of source `reference_elastic_iac_operating_guide.md`)
- `reference/mr-template.md` — GitLab MR body template (verbatim copy of source `mr_template_v1.md`). Referenced by `skills/open-mr/SKILL.md`.

## issues/ (per-cluster, sourced from Consolidated_Issue_Register_v21)

- `issues/eu-b2b.md`
- `issues/eu-cld.md`
- `issues/us-cld.md`
- `issues/ap-cld.md`
- `issues/gl-cld-reporting.md`
- `issues/monitor-clusters.md`
- `issues/cross-cluster.md`

## runbooks/ (incident post-mortems — reference, not numbered procedure)

- `runbooks/eu-cld-cold-tier-incident.md`
- `runbooks/eu-cld-incident-otel-db2-closure.md`
- `runbooks/eu-cld-incident-genius-cxf-soap.md`
- `runbooks/eu-cld-incident-gk-pos-credential-masking.md`
- `runbooks/eu-cld-incident-dual-pipeline-dedup.md`
- `runbooks/eu-cld-incident-kibana-proxy-tls-timeout-deepinvestigation.md`

## specs/ (change specs — templates for similar future changes)

- `specs/eu-b2b-slo-iac-spec.md`
- `specs/eu-b2b-ilm-replica-and-frozen-change-spec.md`
- `specs/eu-b2b-ilm-and-warm-tier-change-spec.md`
- `specs/eu-b2b-hot-tier-optimisation-plan.md`

## cost-plans/

- `cost-plans/cost-optimisation-action-plan.md`
- `cost-plans/elastic-cost-optimisation-app-owner-brief.md`
- `cost-plans/eu-cld-remaining-cost-and-memory-levers.md`
- `cost-plans/us-cld-aggressive-downsizing-plan.md`
- `cost-plans/eu-b2b-wide-cost-sweep.md`
- `cost-plans/elastic-cost-analysis.md` (extracted from PDF)

## playbook/ (reference chapters from Elastic_Optimisation_Playbook_v12)

- `playbook/2-platform-baseline.md`
- `playbook/3-index-lifecycle-management-ilm.md`
- `playbook/4-fleet-agent-collection.md`
- `playbook/5-application-instrumentation.md`
- `playbook/6-index-and-data-hygiene.md`
- `playbook/7-infrastructure-and-cost.md`
- `playbook/8-operational-governance.md`
- `playbook/9-validation-checklists.md`
- `playbook/10-quick-reference.md`
- `playbook/11-source-material.md`
- `playbook/12-cross-session-lessons-learned.md`

## health-snapshots/ (latest health report per cluster)

- `health-snapshots/eu-cld.md`
- `health-snapshots/us-cld.md`
- `health-snapshots/ap-cld.md`
- `health-snapshots/cluster-health-ilm-cost-review.md`

## promoted-skills (created under agent-starter/skills/ — listed here for cross-reference)

Promoted from playbook v12 sub-procedures:

- `skills/dead-data-stream-cleanup/SKILL.md` (playbook §3.7)
- `skills/orphan-index-reattachment/SKILL.md` (§3.8)
- `skills/built-in-ilm-policy-revalidation-after-upgrade/SKILL.md` (§3.9)
- `skills/dedicated-ilm-policy-for-high-retention-network-logs-streams/SKILL.md` (§3.10)
- `skills/ilm-rollover-guard-semantics/SKILL.md` (§3.12)
- `skills/empty-retention-fleet-templates-inherit-prod-ilm/SKILL.md` (§3.13)
- `skills/override-index-template-pattern-priority-300/SKILL.md` (§3.14)
- `skills/warmcold-tier-replica-policy/SKILL.md` (§3.15)
- `skills/systemprocess-metric-tuning/SKILL.md` (§4.4)
- `skills/clock-skew-ingest-pipeline-custom-pinning/SKILL.md` (§4.5)
- `skills/stream-consolidation-via-reroute-processor/SKILL.md` (§6.7)
- `skills/hot-node-low-watermark-relief-and-single-shard-reshard/SKILL.md` (§6.8)
- `skills/raise-then-downsize-two-step-incident-pattern/SKILL.md` (§7.2.3)
- `skills/retention-audit-process/SKILL.md` (§8.3)

Promoted from incident runbooks:

- `skills/eu-b2b-ilm-oom-incident-recovery/SKILL.md` (source: `eu-b2b_ILM_OOM_Incident_Runbook_2026-05-15.md` — numbered Step 1..N)
- `skills/eu-b2b-ilm-change-apply-runbook/SKILL.md` (source: `eu-b2b_ILM_Change_Approval_and_Runbook_2026-05-13.docx` — multi-day timeline with gates)

## _archive/

- `_archive/index.md` — one-line traceability entries for every superseded version, rev*, duplicate, and out-of-scope file in the source corpus.
