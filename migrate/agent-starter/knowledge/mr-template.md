<!--
GitLab MR template for PVH Elastic Cloud Terraform IaC repos
Primary target: pvhcorp/dhco/observability/observability-elasticcloud-deployments-terraform
Install at: .gitlab/merge_request_templates/Default.md (or set per-project default)
Authored: 2026-06-01 (v1) for AI-agent-driven MR creation
Validation policy: advisory — warn on empty fields, do not block submission
-->

## Summary
<!-- One sentence: what this MR changes, expressed as an outcome. AI agent: derive from diff if blank. -->


## Category
<!-- Pick ONE. Drives risk default + reviewer routing. -->
- [ ] `version-bump` — `versions.json` only (stack version)
- [ ] `tier-resize` — autoscaling `size`/`max_size`/`zone_count` in `<region>.tf`
- [ ] `ccs-ccr` — `remote_cluster` wiring (cross-cluster search/replication)
- [ ] `ilm` — index lifecycle policy / retention change
- [ ] `index-template` — component or composable template, mappings, settings
- [ ] `ingest-pipeline` — pipeline processors, grok, dataset routing
- [ ] `alerts` — rule add/remove/silence, PD/Slack routing
- [ ] `integration` — Fleet, Mulesoft, APM, OTel, synthetics
- [ ] `kibana-config` — SAML, spaces, user_settings_yaml, reporting
- [ ] `hotfix` — production incident rollback / patch
- [ ] `refactor` — no functional change (rename, split, docs)

## Cluster(s) affected
<!-- One or more. Use deployment names, not file aliases. AI agent: parse from changed .tf files (ap.tf→ap, eu.tf→eu-b2b/eu-cld, gl.tf→gl-testing, ob.tf→onboarding, us.tf→us-cld, testing.tf→gl-testing). -->
- [ ] `gl-testing` (mandatory first non-eu-b2b target — IaC pre-check sandbox)
- [ ] `eu-b2b`
- [ ] `eu-cld`
- [ ] `us-cld`
- [ ] `onboarding`
- [ ] `all` (stack-wide version bump touching every deployment via `versions.json`)
- [ ] Other: _________________

## Risk
<!-- AI agent default rules:
  - LOW: versions.json only, README only, refactor
  - MEDIUM: <region>.tf size/max_size, ingest-pipeline (additive), index-template (additive)
  - HIGH: remote_cluster, user_settings_yaml, ilm retention reduction, alerts removal, hotfix
-->
- [ ] LOW
- [ ] MEDIUM
- [ ] HIGH

## What changed
<!-- Bulleted list of concrete edits. AI agent: one bullet per logical change, reference file:line where possible. -->
- 

## Why
<!-- Link to ticket / incident / playbook section. If none, state the business or operational driver in one line. -->
- Issue ref: 
- Driver: 

## Files touched
<!-- Auto-fill from diff. Group by file. Flag README.md as `(auto: terraform-docs)` if pre-commit regenerated it. -->
- `<file>` — <one-line change>

## Validation evidence
<!-- Advisory: leave any subsection blank with `n/a — <reason>` rather than deleting it. -->

**Pre-commit / local checks**
- [ ] `terraform fmt` clean
- [ ] `terraform validate` passed
- [ ] `tflint` no new warnings
- [ ] `tfsec` no new findings
- [ ] `terraform-docs` regenerated README (expected diff)

**Plan output**
<!-- Paste `terraform plan` summary (resource counts: add/change/destroy). For HIGH risk, paste the relevant resource diff inline or attach as artifact. -->
```
Plan: 0 to add, 0 to change, 0 to destroy.
```

**Tested in gl-testing first?**
<!-- Required for tier-resize, ccs-ccr, ilm, integration, kibana-config. n/a for version-bump-only, refactor. -->
- [ ] Yes — branch deployed to gl-testing, observed: 
- [ ] No — reason: 

**Observed cluster state after apply (if applied to non-prod)**
- Cluster health: 
- Relevant tier heap/disk %: 
- Sample query / index sanity: 

## Rollback plan
<!-- How to revert. For HIGH risk this must be explicit, not "revert the MR". -->
- Revert mechanism: 
- Estimated rollback time: 
- Data loss risk: 

## Reviewer notes
<!-- Anything reviewer should know that isn't obvious from the diff. -->


---
<!--
AI agent validation checklist (advisory — WARN, don't BLOCK):
  ⚠ Summary empty
  ⚠ No Category checked
  ⚠ No Cluster checked
  ⚠ Risk not set
  ⚠ Files touched does not match git diff
  ⚠ HIGH risk without explicit rollback steps (>"revert the MR")
  ⚠ HIGH risk without gl-testing validation evidence
  ⚠ ILM retention reduction without snapshot/archival reference
  ⚠ remote_cluster change without both-side connectivity check
  ⚠ Branch name does not match `feature/<snake_case>` (breaks bot title formatter)
  ⚠ MR spans more than one Category — prefer splitting (rollback isolation)
-->
