---
name: pre-check-gl-testing
description: Run any stack module change through the gl-testing single-node sandbox first. Mandatory for tier-resize, ccs-ccr, ilm, integration, kibana-config categories per knowledge/mr-template.md.
inputs:
  branch: { type: string, required: true }
  mr_category: { type: string, required: true }   # see knowledge/mr-template.md
outputs:
  plan_pipeline_url: { type: string }
  apply_pipeline_url: { type: string }
  passed: { type: boolean }
---

# gl-testing pre-check

Source of truth: `knowledge/mr-template.md` ("Tested in gl-testing first?" section), `knowledge/playbook/9-validation-checklists.md` §9.3.

## When this is mandatory (from mr-template.md)

| Category | gl-testing required? |
|---|---|
| `tier-resize` | yes |
| `ccs-ccr` | yes |
| `ilm` | yes |
| `integration` | yes |
| `kibana-config` | yes |
| `index-template` | recommended |
| `ingest-pipeline` | recommended |
| `version-bump` | no (versions.json only) |
| `refactor` | no (no functional change) |
| `hotfix` | case-by-case; default no if production outage |

If category is `n/a`, write `n/a — <reason>` in the MR's "Tested in gl-testing first?" field and stop.

## What gl-testing validates

- Terraform syntax (`fmt`, `validate`, `tflint`, `tfsec` per mr-template.md pre-commit checks).
- Provider plan against a real Elastic Cloud deployment.
- Module wiring (variables, outputs, count/for_each).

## What gl-testing does NOT validate (state in MR body)

- HA behaviour — single-node cluster.
- Tiered topology — no warm/cold/frozen on gl-testing.
- Replica behaviour — no zones.
- CCS/CCR — no remote cluster.
- Fleet/Kibana-specific behaviour that depends on multi-node coordination.

The human checker needs to know what gl-testing didn't cover. Put this caveat in the MR's "Reviewer notes" section.

## Steps

1. Confirm `gl-testing` target block exists in `terraform.tfvars` (or equivalent) for the change. If introducing a new module, add a gl-testing target block in the same MR.
2. Trigger the `terraform plan` pipeline against gl-testing.
3. Wait. Read pipeline logs.
4. If plan fails: post the failure to the MR as a comment, mark `passed = false`, stop. Do not retry without diagnosing.
5. If plan succeeds: post the plan summary (resource counts add/change/destroy) and the full diff as a collapsed comment. Trigger `terraform apply` against gl-testing.
6. Read apply output. If apply fails: comment, mark `passed = false`, stop.
7. If apply succeeds: `elasticsearch_cloud_get_deployment` against gl-testing → confirm desired state matches.

## §9.3 — Post-apply observations (mandatory before declaring pass)

- gl-testing cluster health green within 30 min of plan completion.
- All nodes reporting on gl-testing (the one node).
- `GET _cluster/health?wait_for_no_relocating_shards=true` returns within 60 min.
- If ML jobs were involved: reopened after apply.

Only when all of these are clean: comment "gl-testing apply ✓" on the MR with the plan & apply pipeline URLs, mark `passed = true`.

## Cost note

gl-testing is kept alive at ~$37/mo specifically for this purpose. Do not propose decommissioning it — it has no successor. (Memory: `project_gl_testing_iac_precheck`.)
