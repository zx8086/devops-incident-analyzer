# Handover: elasticstack Terraform provider lock bump (elastic-iac GitOps repo)

**Date**: 2026-07-31
**Ticket(s)**: None yet — no Linear ticket has been created for this. Create one in the **Siobytes** team before starting implementation (see "Workflow" below); this doc is the full plan to paste into it.
**Parent epic**: None (standalone infra maintenance item, not part of a DevOps Incident Analyzer epic)
**Target repo**: `observability-elastic-iac` — GitLab project ID `82850717`, https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac (per `reference_elastic_iac_migrated_to_gitlab_com.md`)
**Target repo state at investigation time**: `HEAD` (default branch `main`), read via `gitlab_get_file_content`/`gitlab_get_repository_tree` MCP tools — no local clone exists in this session
**Repo this doc lives in**: `devops-incident-analyzer` (this repo only hosts the *agent* that proposes changes to elastic-iac via MR — it does not contain the `.tf` files itself)
**Suggested branch name** (in the elastic-iac repo): `bump-elasticstack-provider-0.16.3`

## TL;DR

The elastic-iac GitOps repo pins `elastic/elasticstack` at `~> 0.16.0` in three stacks (`slos`, `synthetics`, `spaces`) and one module (`space`), but all three `.terraform.lock.hcl` files are locked to `0.16.1` while `0.16.3` is the latest available release (published 2026-07-23). Because the version *constraint* already allows any `0.16.x`, this is a lock-file refresh, not a constraint edit — `terraform init -upgrade` picks it up with no `.tf` changes required. Verified live against the upstream GitHub repo that 0.16.3's one breaking change (Kibana dashboard `options_list_control_config`/`range_slider_control_config` restructuring) does not apply — no file in the elastic-iac repo references `kibana_dashboard`, `options_list_control_config`, or `range_slider_control_config`. Also verified that the `Mastercard/restapi` workaround provider in `stacks/slos/versions.tf` (used for `synthetics_availability_indicator`, since the native provider doesn't expose it) is still necessary as of 0.16.3 — no native replacement has shipped. Success = lock files updated to `0.16.3` across all four locations, a clean `terraform plan` (no unexpected diff) on each affected stack, and the restapi workaround comment left untouched since it's still accurate.

## Context — how this came to be

This surfaced from a log-review request in the `devops-incident-analyzer` session (unrelated ticket: reviewing agent log timing for SIO-1307, a polling-budget latency issue in this repo's own `packages/mcp-server-elastic-iac`). The user then asked, separately, whether any Terraform provider updates might improve "the Elastic-IaC process." That process is the GitOps proposer model (`project_elastic_iac_gitops_proposer_model.md`, `project_elastic_iac_agent_proposes_gitops_disposes.md`): the agent in this repo edits Terraform config, opens an MR against the elastic-iac repo, and GitLab CI computes the authoritative plan on the MR — this repo's own `mcp-server-elastic-iac` package deliberately only exposes `terraform_search_modules`/`terraform_search_providers` (public registry search) and no `terraform plan`/`apply` locally ([packages/mcp-server-elastic-iac/src/tools/terraform.ts](packages/mcp-server-elastic-iac/src/tools/terraform.ts) — see the SIO-912 comment at the top of that file for why local terraform execution was removed).

Investigating "any provider updates" required reading the actual `.tf`/`.terraform.lock.hcl` files in the elastic-iac repo (this repo has none), which was done live via the GitLab MCP tools (`gitlab_get_file_content`, `gitlab_get_repository_tree`, `gitlab_search`) against project `82850717`, cross-referenced against the live Terraform Registry (`get_latest_provider_version` MCP tool) and the upstream provider's GitHub releases/issues (`gh api repos/elastic/terraform-provider-elasticstack/...`).

## Where the bodies are buried

All paths below are in the **elastic-iac repo** (project `82850717`), not this repo.

### Provider version constraints (unchanged by this work — `~>` already permits 0.16.3)

`stacks/slos/versions.tf`:
```hcl
terraform {
  required_version = ">= 1.5"

  required_providers {
    elasticstack = {
      source  = "elastic/elasticstack"
      version = "~> 0.16.0"
    }
    # Retained for the synthetics SLO indicator only — the native provider does
    # not expose synthetics_availability_indicator at 0.14.5 (verified via
    # canonical schema diff 2026-05-10). Permanent until upstream Elastic issue
    # #610 ships. See feedback_elasticstack_slo_provider_gaps.md.
    restapi = {
      source  = "Mastercard/restapi"
      version = "~> 2.0"
    }
  }
}
```

`stacks/synthetics/versions.tf` — same `elasticstack ~> 0.16.0` + `restapi ~> 2.0` + also `hashicorp/null ~> 3.2`.

`stacks/spaces/versions.tf` — `elasticstack ~> 0.16.0` only.

`modules/space/versions.tf` — `elasticstack >= 0.16.0` (open-ended, no restapi dependency).

### Locked versions (this IS what needs to change)

All three stack lock files (`stacks/slos/.terraform.lock.hcl`, `stacks/synthetics/.terraform.lock.hcl`, `stacks/spaces/.terraform.lock.hcl`) currently pin:
```
provider "registry.terraform.io/elastic/elasticstack" {
  version     = "0.16.1"
  constraints = ">= 0.14.0, ~> 0.16.0"
  ...
}
```
`modules/space/.terraform.lock.hcl` was not individually re-verified for its exact locked patch version in this session (module, not a root stack — inherits whichever provider version the consuming stack resolves) — check it as part of implementation.

Latest registry version confirmed live via `get_latest_provider_version(namespace: "elastic", name: "elasticstack")` → **`0.16.3`**, published `2026-07-23T04:43:17Z` per `gh api repos/elastic/terraform-provider-elasticstack/releases/tags/v0.16.3`.

### Why the `restapi` workaround is still needed (not this ticket's job to remove, just confirm)

`gh api repos/elastic/terraform-provider-elasticstack/issues/610` → **closed** (2025-10-15), title "Support Synthetics APIs as Terraform resources" — but that shipped general `elasticstack_kibana_synthetics_monitor` support, not the SLO availability indicator specifically. Searched 0.16.2 and 0.16.3 changelogs plus a GitHub code search across the whole provider repo for `synthetics_availability_indicator` — zero hits in either. The related issue #1152 turned out to be about a different feature entirely (Global Parameters for secrets). Conclusion: the code comment referencing issue #610 as the blocker is stale/imprecise (that issue is closed but didn't ship the specific gap), but the underlying gap is real and still open — **do not remove the `restapi` provider or its comment as part of this work**; at most, correct the comment to stop citing #610 as if it's still open (it's closed, just not the relevant fix).

## The fix (step-by-step)

This work happens **in the elastic-iac repo**, via the normal MR flow (either by hand or by asking the agent's fleet-upgrade-style `elastic_cloud`/`gitlab_*` IaC tools to propose it, since this is exactly the GitOps-proposer pattern the agent already supports for other config changes — see `reference_config_edit_workflow_recipe.md` in this repo's memory for the general pattern).

1. **Clone/checkout** the elastic-iac repo (`git@gitlab.com:pvhcorp/dhco/observability/observability-elastic-iac.git`), branch `bump-elasticstack-provider-0.16.3` off `main`.
2. **For each of the three stacks** (`stacks/slos`, `stacks/synthetics`, `stacks/spaces`) and the one module (`modules/space`), run:
   ```bash
   terraform init -upgrade
   ```
   This rewrites `.terraform.lock.hcl` to `0.16.3` (still satisfying `~> 0.16.0` / `>= 0.16.0`) and pulls in the new provider binary hashes. No `.tf` file edits are needed — the constraint doesn't change.
3. **Sanity-check the breaking change doesn't apply** (already verified in this session via `gitlab_search` for `kibana_dashboard`/`options_list_control_config`/`range_slider_control_config` across the whole repo — zero matches — but re-confirm at implementation time in case new dashboard-managing `.tf` landed between now and then):
   ```bash
   grep -rn "options_list_control_config\|range_slider_control_config\|elasticstack_kibana_dashboard" .
   ```
   Expect no output. If it now returns matches, read the 0.16.3 release notes' breaking-change section before proceeding — the control-config attributes need to be wrapped in a new `by_field { ... }` block (state auto-upgrades on `apply`, but `.tf` source must be updated to match the new nested shape).
4. **Run `terraform plan`** in each of the three stacks. Expect **no diff** — this is purely a provider binary/lock bump, not a resource change. Any unexpected diff means one of the 0.16.2/0.16.3 behavior changes below is touching a resource this repo manages; investigate before merging:
   - 0.16.2: `elasticstack_elasticsearch_ml_anomaly_detection_job` `timeouts` changed from block to attribute syntax (breaking, but only affects that specific resource type).
   - 0.16.3 Fleet-adjacent fixes worth knowing about (informational, shouldn't cause plan diffs, but explain behavior changes if seen): fix for `elasticstack_fleet_integration_policy` post-apply inconsistency on Stack 9.5 ([#4055](https://github.com/elastic/terraform-provider-elasticstack/pull/4055)), Fleet 9.5 `DeleteKibanaAssets` uninstall fallback ([#4073](https://github.com/elastic/terraform-provider-elasticstack/pull/4073)), Fleet agent policy `policy_id`-omitted create fix ([#3937](https://github.com/elastic/terraform-provider-elasticstack/pull/3937)).
5. **Commit** the four updated `.terraform.lock.hcl` files (and any `HOW-TO.md`/changelog the repo conventionally updates — check `AGENTS.md`/`README.md` at the elastic-iac repo root for its own contribution conventions, not this repo's).
6. **Open an MR** against `main`. Let elastic-iac's own CI compute the authoritative plan (per the GitOps-proposer model — this repo's agent never applies locally).

## Verification

Run from within a checkout of the **elastic-iac repo**, not this repo:

```bash
# Per stack (slos, synthetics, spaces) and the space module:
cd stacks/slos && terraform init -upgrade && terraform validate && terraform plan
cd ../synthetics && terraform init -upgrade && terraform validate && terraform plan
cd ../spaces && terraform init -upgrade && terraform validate && terraform plan
cd ../../modules/space && terraform init -upgrade && terraform validate
```
Expected: `terraform validate` passes on all four; `terraform plan` shows **no changes** on the three stacks (module has no standalone plan). If `tflint`/`.pre-commit-config.yaml` hooks are configured (both exist at repo root per the earlier tree listing), also run:
```bash
tflint --config=.tflint.hcl
```

No verification runs in **this** repo (`devops-incident-analyzer`) — nothing here changes as part of this work. If you want to smoke-test that the agent still proposes elastic-iac changes correctly after the bump, the closest existing coverage is around the fleet-upgrade and drift-check flows (`packages/agent/src/iac/fleet-upgrade.test.ts`, `packages/agent/src/iac/version-live-parity.test.ts`), but those don't touch provider versions and shouldn't need re-running for this change.

## Files to modify

| Repo | File | Change |
|---|---|---|
| elastic-iac | `stacks/slos/.terraform.lock.hcl` | Lock bump 0.16.1 → 0.16.3 |
| elastic-iac | `stacks/synthetics/.terraform.lock.hcl` | Lock bump 0.16.1 → 0.16.3 |
| elastic-iac | `stacks/spaces/.terraform.lock.hcl` | Lock bump 0.16.1 → 0.16.3 |
| elastic-iac | `modules/space/.terraform.lock.hcl` | Lock bump to 0.16.3 (exact prior version not re-verified this session — check at implementation time) |
| elastic-iac | `stacks/slos/versions.tf` (optional, low priority) | Comment cleanup: stop citing closed issue #610 as the open blocker; note it shipped generic synthetics monitors but not the SLO availability indicator specifically |
| devops-incident-analyzer | *(none)* | No changes needed in this repo |

## Workflow

- No Linear issue exists yet for this. Create one in **Siobytes** team, commit format `SIO-XX: message`, before starting implementation (per this repo's CLAUDE.md: "ALWAYS create a Linear issue before executing implementation plans"). Title suggestion: "Bump elasticstack Terraform provider lock to 0.16.3 across elastic-iac stacks."
- Branch off `main` in the **elastic-iac repo** (not this repo) — `bump-elasticstack-provider-0.16.3`.
- Linear status transitions: In Progress → In Review → Done (Done only with explicit user approval, per this repo's guardrails — that rule is stated as a general practice, apply it here even though the code change lands in a different repo).
- Commit message template (elastic-iac repo):
  ```bash
  git commit -m "$(cat <<'EOF'
  SIO-XX: bump elasticstack provider lock to 0.16.3

  Lock was pinned at 0.16.1 while the ~> 0.16.0 constraint already
  permitted 0.16.3. No breaking changes apply (dashboard control-config
  restructuring in 0.16.3 doesn't affect any resource in this repo).
  Picks up Fleet 9.5 apply/uninstall fixes relevant to the fleet-upgrade
  flow.
  EOF
  )"
  ```
- PR/MR in elastic-iac should be created ready-for-review (not draft), per this repo's "always create PRs as ready for review" convention — apply the same standard there unless the elastic-iac repo's own `AGENTS.md` says otherwise (not yet read in this session — check it first).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `modules/space` locked at a different/older elasticstack version than the three stacks | Low-medium (not directly verified this session) | Check its lock file explicitly before assuming it's also 0.16.1; its constraint is `>= 0.16.0` (open-ended) so it may already float higher |
| New `.tf` added between now and implementation that uses `kibana_dashboard` control-config blocks | Low | Step 3's grep re-check catches this before it becomes a broken apply |
| `terraform plan` shows unexpected diff from one of the 40+ intervening PRs in 0.16.2/0.16.3 | Low-medium (large release, only spot-checked the changelog, didn't diff every PR against every resource this repo manages) | Read any plan diff carefully before merging; if a diff appears, it's informative (surfaces a real drift/behavior change) not just noise — investigate rather than blindly accepting |
| elastic-iac repo has its own CI gate (`.gitlab-ci.yml` exists) that could behave differently on the provider bump | Low | Let CI run on the MR per the GitOps-proposer model; don't bypass it |

## Out of scope

- Removing or replacing the `Mastercard/restapi` workaround provider — confirmed still necessary (no native `synthetics_availability_indicator` support in elasticstack 0.16.3).
- Any `.tf` resource/config changes — this is a lock-file-only bump.
- SIO-1307 (polling-budget latency in this repo's `mcp-server-elastic-iac`/`agent` packages) — unrelated, surfaced in the same session from an earlier log-review request, tracked separately in Linear.
- Auditing every one of the ~60 changelog entries across 0.16.2/0.16.3 against every resource elastic-iac manages — only spot-checked entries plausibly relevant to Fleet (since that's what this repo's fleet-upgrade flow drives) and the one breaking change.

## Related code references

- [packages/mcp-server-elastic-iac/src/tools/terraform.ts](packages/mcp-server-elastic-iac/src/tools/terraform.ts) — this repo's only Terraform-related code; registry search only, no plan/apply (SIO-912 comment explains why local execution was removed).
- `reference_elastic_iac_migrated_to_gitlab_com.md` — confirms elastic-iac now lives at GitLab project `82850717`.
- `project_elastic_iac_gitops_proposer_model.md` / `project_elastic_iac_agent_proposes_gitops_disposes.md` — the propose-only pattern this bump should follow (agent/human proposes via MR, elastic-iac's own CI computes the authoritative plan).
- `reference_elastic_iac_repo_three_layer_structure.md` — background on the `modules/` vs `stacks/` split if unfamiliar with the repo layout.
- `reference_config_edit_workflow_recipe.md` — general recipe for how this agent proposes config edits to elastic-iac, useful if automating this bump via the agent rather than doing it by hand.

## Memory references

- `reference_elastic_iac_migrated_to_gitlab_com.md` — project ID/URL for elastic-iac.
- `project_elastic_iac_gitops_proposer_model.md`, `project_elastic_iac_agent_proposes_gitops_disposes.md` — propose-only architecture.
- `reference_elastic_iac_repo_three_layer_structure.md` — repo layout (`modules/` / `stacks/` / `environments/`).
- `reference_elasticstack_index_template_provider_schema.md` — prior investigation into elasticstack provider schema quirks (different resource, same provider — useful background on how this provider's schema has surprised us before).
- `reference_config_edit_workflow_recipe.md` — how the agent proposes elastic-iac config edits end-to-end.
- `feedback_handoff_docs_main_branch.md` — why this doc is committed to `main` in *this* repo despite the work targeting a different repo.
