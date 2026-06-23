# HANDOFF: provision eu-cld-monitor/lifecycle-policies stack instance

- **Date**: 2026-06-23
- **Ticket**: SIO-1012 — https://linear.app/siobytes/issue/SIO-1012 (agent warn-only fix shipped as PR #303; this handoff is the REPO-SIDE provisioning the agent deliberately does NOT do)
- **Parent context**: SIO-1011 (https://linear.app/siobytes/issue/SIO-1011, PR #302 merged) — the multi-file ILM onboard fix that produced MR !248.
- **Target repo**: `pvhcorp/dhco/observability/observability-elastic-iac` (GitLab project **82850717**) — this is a SEPARATE repo from devops-incident-analyzer. The work below happens THERE, not in this codebase.
- **Suggested branch**: `provision/eu-cld-monitor-lifecycle-policies`
- **Who must do this**: a human with push access to the elastic-iac repo (the incident-analyzer session has no branch/commit tools for that GitLab project — it can read + open MRs from an existing branch only, so it cannot create this MR itself).

## TL;DR

MR !248 merged two new ILM policy files (`metricbeat.json`, `elastic-cloud-logs.json`) into `environments/eu-cld-monitor/lifecycle-policies/`, but the apply was a **no-op** — the policies are NOT live in Elasticsearch. Cause: the repo's CI discovers applyable `(deployment, stack)` combos by `find environments/<dep>/<stack>/terraform.tfvars`, and that directory has no `terraform.tfvars`. **Fix = add one file**: `environments/eu-cld-monitor/lifecycle-policies/terraform.tfvars`. No backend flip, no state migration, no terraform import needed. After it merges, CI emits a real plan/apply for the two policies; click the manual apply on `main`.

## Context — how this came to be

A user onboarded two ILM policies to `eu-cld-monitor/lifecycle-policies` via the elastic-iac agent. SIO-1011 fixed the agent so the multi-file full-body onboard drafts + merges (MR !248). But `eu-cld-monitor` was never provisioned for the `lifecycle-policies` stack, so CI silently produced a no-op. SIO-1012 made the agent WARN about this going forward (PR #303), but the agent is a config maker, not a Terraform author — it never writes tfvars. Provisioning is this repo-side task.

## Where the bodies are buried (all verified live on `main`, 2026-06-23)

1. **CI discovery** — `scripts/ci-generate-pipeline.sh` (project 82850717), discovery loop:
   ```bash
   done < <(find "$ROOT_DIR/environments" -mindepth 3 -maxdepth 3 -type f -name terraform.tfvars | sort)
   ```
   A combo with config JSON but no `terraform.tfvars` is never discovered -> 0 plan/apply pairs -> `no-op` child pipeline. `lifecycle-policies` IS already in `DEFAULT_CI_STACKS`, so no allowlist change is needed.

2. **The no-op proof** — post-merge pipeline #2621776710 `generate-pipeline` log: `Generated child-pipeline.yml with 0 plan/apply job pair(s).`

3. **Current dir contents** — `environments/eu-cld-monitor/lifecycle-policies/` has ONLY:
   - `metricbeat.json`
   - `elastic-cloud-logs.json`
   (no `terraform.tfvars` — that is the entire gap)

4. **Stack code is ready** — `stacks/lifecycle-policies/`:
   - `backend.tf` is already `backend "http"` (GitLab managed state), SHARED across all deployments; `STATE_NAME = "<deployment>-<stack>"` is set at `terraform init`. The new state `eu-cld-monitor-lifecycle-policies` is created lazily on first apply. **No backend flip / migration.**
   - `variables.tf` requires exactly: `deployment_name`, `config_path`, `elasticsearch_endpoints`, `ssm_api_key_path` (the rest have defaults).
   - `main.tf` uses `elasticstack_elasticsearch_index_lifecycle` via `for_each` over the JSON files. This resource is a **PUT/upsert** — first apply adopts the already-live `metricbeat`/`elastic-cloud-logs` policies idempotently. **No `terraform import` needed.**

5. **The exact tfvars values** — copied from the SIBLING stacks already provisioned for this same deployment (do NOT invent them):
   - `environments/eu-cld-monitor/cluster-defaults/terraform.tfvars`
   - `environments/eu-cld-monitor/agent-policies/terraform.tfvars`
   Both use endpoint `https://6e0c520a021b4a4babd8f9029f87c06e.eu-central-1.aws.cloud.es.io:443` and ssm path `/elastic/observability/eu_monitor/es_api_key`.
   **LANDMINE**: the SSM path abbreviates the deployment as `eu_monitor`, NOT `eu_cld_monitor`. It must be copied from a sibling, never constructed.

## The fix (one file)

Create `environments/eu-cld-monitor/lifecycle-policies/terraform.tfvars` with EXACTLY:

```hcl
deployment_name = "eu-cld-monitor"
config_path     = "../../environments/eu-cld-monitor/lifecycle-policies"

elasticsearch_endpoints = ["https://6e0c520a021b4a4babd8f9029f87c06e.eu-central-1.aws.cloud.es.io:443"]
ssm_api_key_path        = "/elastic/observability/eu_monitor/es_api_key"
```

(Match the sibling-file style: a blank line before the endpoints block, aligned `=`. Do NOT add `bootstrap_existing_indices` — that is a cluster-defaults-only var; lifecycle-policies' `variables.tf` does not declare it and would warn/ignore.)

Branch off `main`, commit this one file, open an MR titled e.g. `provision eu-cld-monitor/lifecycle-policies (terraform.tfvars)`, scope it to that one file.

## Verification

On the MR (CI computes the plan automatically):
1. The merge-request pipeline now emits a real `plan:eu-cld-monitor:lifecycle-policies` job (NOT a no-op child). The GitLab MR plan widget should show **2 to add** (metricbeat, elastic-cloud-logs) — they are creates in TF state even though already live, because the first apply adopts them.
2. Merge to `main`. The post-merge pipeline exposes a **manual** `apply:eu-cld-monitor:lifecycle-policies` job. Click it.
3. Apply re-plans + applies in one container; the `verify:eu-cld-monitor:lifecycle-policies` job (drift-check) should converge green (exit 0).
4. Confirm live in Elasticsearch (eu-cld-monitor): the `metricbeat` and `elastic-cloud-logs` ILM policies exist with hot{max_age 1d, max_primary_shard_size 2gb, priority 100, rollover} + delete{min_age 3d, delete_searchable_snapshot true}. e.g. via the elastic MCP `elasticsearch_ilm_get_lifecycle` against that deployment, or Kibana > Stack Management > ILM.

Expected: the two policies that merged as a no-op in MR !248 are now actually applied.

## Files to modify (in the elastic-iac repo, NOT this one)

| file | change |
|------|--------|
| `environments/eu-cld-monitor/lifecycle-policies/terraform.tfvars` | CREATE (4 keys above) |

Nothing else. No `stacks/`, no `backend.tf`, no CI changes.

## Risks and edge cases

| risk | likelihood | mitigation |
|------|-----------|------------|
| Wrong SSM path abbreviation breaks the apply (auth) | medium if typed by hand | Copy `ssm_api_key_path` verbatim from `environments/eu-cld-monitor/cluster-defaults/terraform.tfvars` (`eu_monitor`). |
| Plan shows a destroy/replace instead of create-adopt | low | elasticstack ILM is PUT/upsert; if a diff looks like delete, STOP and inspect — do not apply. |
| Policy bodies in repo differ from live (drift on adopt) | low | The bodies were authored to match the live shape; the apply re-plan + verify job will flag residue (exit 2) — investigate before merge if so. |

## Out of scope

- Any change to the incident-analyzer agent (SIO-1012 warn-only already shipped as PR #303).
- Generalizing provisioning to other deployments/stacks — this handoff is ONLY eu-cld-monitor/lifecycle-policies.
- `terraform import` — not needed (PUT/upsert resource).

## Related code references (elastic-iac repo)

- `scripts/ci-generate-pipeline.sh` — combo discovery + plan/apply emission
- `stacks/lifecycle-policies/{backend.tf,variables.tf,main.tf}` — stack code (ready; no change)
- `environments/eu-cld-monitor/cluster-defaults/terraform.tfvars` + `.../agent-policies/terraform.tfvars` — sibling tfvars to copy values from
- MR !248 (the no-op onboard) — https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/248
- no-op pipeline #2621776710 (child #2621781889)

## Memory references

- `reference_iac_ci_combo_discovery_and_noop` (SIO-1012) — the CI discovery + no-op mechanism + the eu_monitor SSM landmine
- `reference_multi_file_ilm_fullbody_onboard` (SIO-1011) — the onboard that produced MR !248
- `reference_session_gitlab_no_write_tools` — why this is a handoff, not an agent-created MR
- `reference_apply_job_not_parent_pipeline` — read the apply JOB status, not the parent pipeline, when checking "is it live"
