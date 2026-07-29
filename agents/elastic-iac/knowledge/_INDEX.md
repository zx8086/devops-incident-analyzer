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

## playbook sub-procedures (SIO-1281: restored to the playbook, not skills)

These 14 were briefly converted to skill directories that were never declared in `agent.yaml`
and therefore never loaded. SIO-1281 restored them to their playbook sections and deleted the
orphaned directories. They are reference knowledge the agent consults, not pipeline-stage
procedures — see `docs/development/authoring-skills-and-runbooks.md`.

- `playbook/3-index-lifecycle-management-ilm.md` §3.7 — Dead data stream cleanup
- `playbook/3-index-lifecycle-management-ilm.md` §3.8 — Orphan index reattachment
- `playbook/3-index-lifecycle-management-ilm.md` §3.9 — Built-in ILM policy revalidation after upgrade
- `playbook/3-index-lifecycle-management-ilm.md` §3.10 — Dedicated ILM policy for high-retention network-logs streams
- `playbook/3-index-lifecycle-management-ilm.md` §3.12 — ILM rollover guard semantics
- `playbook/3-index-lifecycle-management-ilm.md` §3.13 — Empty retention-fleet templates inherit prod ILM
- `playbook/3-index-lifecycle-management-ilm.md` §3.14 — Override index template pattern (priority 300)
- `playbook/3-index-lifecycle-management-ilm.md` §3.15 — Warm/cold-tier replica policy
- `playbook/4-fleet-agent-collection.md` §4.4 — system.process metric tuning
- `playbook/4-fleet-agent-collection.md` §4.5 — Clock-skew ingest pipeline (@custom) pinning
- `playbook/6-index-and-data-hygiene.md` §6.7 — Stream consolidation via reroute processor
- `playbook/6-index-and-data-hygiene.md` §6.8 — Hot-node low-watermark relief and single-shard reshard
- `playbook/7-infrastructure-and-cost.md` §7.2.3 — Raise-then-downsize two-step incident pattern
- `playbook/8-operational-governance.md` §8.3 — Retention audit process

From incident runbooks — archived, NOT loaded into the prompt:

Both are point-in-time records of the 2026-05-15 eu-b2b ILM incident, not reusable procedure.
They live in a **subdirectory** of `_archive/` on purpose: `loadKnowledge` reads only `*.md`
directly under a category path (`manifest-loader.ts:180`, no recursion), so nesting them keeps
~441 lines out of every elastic-iac turn. `_archive/` itself IS a loaded category.

- `_archive/eu-b2b-ilm/eu-b2b-ilm-oom-incident-recovery.md` (source: `eu-b2b_ILM_OOM_Incident_Runbook_2026-05-15.md`)
- `_archive/eu-b2b-ilm/eu-b2b-ilm-change-apply-runbook.md` (source: `eu-b2b_ILM_Change_Approval_and_Runbook_2026-05-13.docx`)

## _archive/

- `_archive/index.md` — one-line traceability entries for every superseded version, rev*, duplicate, and out-of-scope file in the source corpus.
