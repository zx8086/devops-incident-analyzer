# Elastic-IaC ↔ observability-elastic-iac alignment — design

- **Date:** 2026-06-16
- **Status:** Approved (brainstorming complete; ready for implementation plan)
- **Repo:** `zx8086/devops-incident-analyzer`, branch `claude/magical-bohr-9c8d91`
- **Target GitOps repo:** `gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac` (project id **82850717**)

## TL;DR

The elastic-iac agent's *operating contract* with the live GitLab GitOps repo is sound and
was verified live: every on-demand CI job the agent's MCP tools trigger exists in the repo's
`.gitlab-ci.yml` with the exact names the tool defaults expect, and the JSON file layout the
shipped skills edit (`environments/_deployments/<cluster>.json`,
`environments/<cluster>/lifecycle-policies/<policy>.json`) matches the repo. The misalignment
is concentrated in the agent's **identity/knowledge layer**, which still names a repo that
returns GitLab 404 (`observability-elasticcloud-deployments-terraform`) and a dead project id
(`71488350`). It only works today because `.env` / config defaults override the dead identity —
a latent break the moment that env config is unset or diverges. This work realigns the
identity layer to the live repo, reconciles the stale repo map, prunes dead routing left over
from the propose-only migration, adds a smoke test that pins the CI artifact contract, and
sweeps stale references in docs.

## Ground truth (verified live 2026-06-16 via GitLab API)

| Check | Result |
|---|---|
| `observability-elastic-iac` (user URL, MCP `gitops.project` default) | **EXISTS** — project id **`82850717`**, created 2026-06-03, default branch `main` |
| `observability-elasticcloud-deployments-terraform` (agent.yaml / SOUL / docs) | **404 — does not exist** |
| Project id `71488350` (agent.yaml, config.ts fallback, bridge test) | **404 — dead** (old self-hosted `gitlab.siobytes.cloud` id) |
| `environments/_deployments/<cluster>.json` | Present for all clusters |
| `environments/<cluster>/lifecycle-policies/<policy>.json` | Present, top-level phase shape as `add-ilm-policy` assumes |
| `.gitlab-ci.yml` on-demand jobs | All 5 present, names match tool defaults: `drift-check-on-demand` (L192), `drift-check-synthetics-on-demand` (L320), `synthetics-push-on-demand` (L405), `fleet-upgrade-preview-on-demand` (L517), `fleet-upgrade-apply-on-demand` (L549) |
| Live cluster set | `eu-b2b`, `eu-cld` (+`-monitor`), `ap-cld` (+`-monitor`), `us-cld` (+`-monitor`), `gl-testing`, `eu-onboarding`, `gl-cld-reporting` |
| Live repo top-level | has **both** `environments/` (JSON — what skills edit) and `stacks/` (HCL — what iac-repo-map describes) |

Background: SIO-891 (PR #189) migrated the GitOps target off the dead `gitlab.siobytes.cloud`.
The two-target split (read `repository.*` vs write `gitops.*`) and the live id `82850717` are
documented in memory `reference_elastic_iac_migrated_to_gitlab_com`.

## Where the bodies are buried

**Dead repo identity (runtime works only because env defaults override it):**

- `agents/elastic-iac/agent.yaml:15` — `repository.url` = the 404 `*-deployments-terraform` path
- `agents/elastic-iac/agent.yaml:16` — `project_id: 71488350` (dead)
- `agents/elastic-iac/SOUL.md:5` — prose names `observability-elasticcloud-deployments-terraform`
- `agents/elastic-iac/knowledge/mr-template.md:3` — `Primary target:` names the dead path
- `agents/elastic-iac/knowledge/iac-repo-map.md:6-7` — `Real path:` = dead path, `project ID: 71488350`
- `packages/mcp-server-elastic-iac/src/config.ts:125` — `repository.projectId` fallback `"71488350"`.
  **Landmine:** only used when `ELASTIC_IAC_GITLAB_PROJECT_ID`/`ELASTIC_IAC_GITLAB_PROJECT` is unset;
  reads then 404 silently. (`gitops.project` default on L130 is already correct.)
- `packages/gitagent-bridge/src/elastic-iac-load.test.ts:36` — asserts `project_id === 71488350`,
  i.e. pins the dead id. **Must move atomically with `agent.yaml`** or the build breaks.

**Stale repo map (agent reads at bootstrap):**

- `agents/elastic-iac/knowledge/iac-repo-map.md:11-36` — describes only `stacks/<cluster>/*.tf`
  (HCL). The shipped skills edit `environments/<cluster>/**.json`. The live repo has both trees,
  so the map is not wrong — it is *missing the half the agent actually uses* and lists a stale
  cluster set (`eu-b2b-dev`, `eu-b2b-stg` instead of the real fleet).

**Stale model ids:**

- `agents/elastic-iac/agent.yaml:10-11` — `claude-opus-4-6` / `claude-sonnet-4-6`. Current: Opus 4.8 / Sonnet 4.6.

**Dead routing (left over from the SIO-912 propose-only migration):**

- `agents/elastic-iac/tools/elastic-iac.yaml` — the `action` enum (L13) and `action_tool_map` (L56-104)
  still list local-git + local-terraform verbs and `draft`/`plan` actions:
  - `read_repo` (L65-71): `git_clone`, `git_checkout`, `git_status`, `git_diff`
  - `draft` (L72-77): `git_create_branch`, `git_commit`, `terraform_fmt` (+ the two registry searches)
  - `plan` (L78-80): `terraform_validate`, `terraform_plan`
  - `open_mr` (L85-87): `git_push`
  - `paths` description (L27): `stacks/<cluster>/`
  - Verified 2026-06-16: zero references to these actions/verbs anywhere in `agents/elastic-iac/**`
    skills/prose or `packages/agent/src` — safe to prune.

**Test gap:**

- `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts` covers only pure helpers
  (`buildCommitFileBody`, `flipCommitAction`, `childPipelineId`, `planJob`, `findJobByName`,
  `parsePipelineRef`, synthetics-vars). No test pins the **CI artifact decode contract** end to end,
  so a repo-side rename of a job/artifact would not be caught.

## The fix (ordered commits, single ticket)

### Commit 1 — identity fix (code + test together)

1. `agent.yaml:15` → `url: https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac`
2. `agent.yaml:16` → `project_id: 82850717`
3. `SOUL.md:5` → name `observability-elastic-iac`
4. `mr-template.md:3` → `Primary target: pvhcorp/dhco/observability/observability-elastic-iac`
5. `iac-repo-map.md:6-7` → `Real path:` = live path, `GitLab project ID: 82850717`
6. `config.ts:125` → `projectId: Bun.env.ELASTIC_IAC_GITLAB_PROJECT_ID ?? "82850717"`
7. `elastic-iac-load.test.ts:36` → `expect(...).toBe(82850717)` (YAML loads it as a number; keep numeric)

### Commit 2 — repo-map reconcile + model ids

8. `iac-repo-map.md` — add the `environments/` tree as the **primary** layout the agent edits
   (`_deployments/<cluster>.json`, `_shared/`, `<cluster>/lifecycle-policies/<policy>.json`, etc.),
   keep `stacks/*.tf` noted as the Terraform that CI plans; refresh cluster list to the live set.
9. `agent.yaml:10-11` → `preferred: claude-opus-4-8`, `fallback: claude-sonnet-4-6`

### Commit 3 — prune dead routing

10. `tools/elastic-iac.yaml`:
    - `action` enum → `[read_state, read_repo, propose, open_mr, review_pipeline, status]`
    - `read_repo` → keep only `gitlab_get_repository_tree`, `gitlab_get_file_content`
    - drop the `draft` and `plan` action blocks + their `action_descriptions`/`action_keywords`
    - `open_mr` → keep only `gitlab_create_merge_request`
    - `paths` description (L27) → `environments/<cluster>/` (or generalize)
    - trim `mcp_patterns`/`description`/`prompt_template` wording that implies local `terraform fmt/validate/plan`

### Commit 4 — smoke test (CI artifact contract)

11. `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts` (or a new `*-contract.test.ts`):
    - **Fixture replay** of the artifact parsers using recorded JSON from the live repo's reports
      (tfplan-report, drift-report, synthetics-drift-report, fleet-upgrade-report): assert
      `planJob` / `findJobByName` resolve the live job names, and the report-field extraction
      surfaces the documented counts/fields.
    - **Job-name guard:** a test asserting the tool default job-name constants equal the live
      `.gitlab-ci.yml` set (the 5 on-demand jobs above), so a repo-side rename trips a red test.
    - Fixtures captured per `reference_fixture_capture_recipe`; mirror real MCP shapes per
      `feedback_extractor_fixtures_must_mirror_real_mcp`.

### Commit 5 — doc sweep (separate commit, same ticket)

12. Replace `siobytes/elastic-iac` + `71488350` leftovers:
    - `docs/elastic-iac-drift-report-contract.md:9`
    - `docs/configuration/environment-variables.md:104`
    - `docs/configuration/mcp-server-configuration.md` (L632, L645)
    - design specs referencing the dead path where it reads as current state (leave historical
      "probed pre-migration" notes intact, but correct any line that asserts the dead id as live)

## Verification

```bash
bun run typecheck && bun run lint && bun run test
bun run yaml:check
bun run --filter '@devops-agent/gitagent-bridge' test   # elastic-iac-load.test.ts
bun run --filter '@devops-agent/mcp-server-elastic-iac' test
```

Live probe (proves identity now resolves):

```bash
# from repo root, token in .env
TOKEN=$(grep -E '^ELASTIC_IAC_GITLAB_TOKEN=' .env | cut -d= -f2-)
curl -s -o /dev/null -w '%{http_code}\n' -H "PRIVATE-TOKEN: $TOKEN" \
  https://gitlab.com/api/v4/projects/82850717/repository/tree?ref=main
# expect: 200
```

Cold-restart caveat: the elastic-iac MCP (:9086) memoizes config at boot; a running server keeps
the old values until a cold restart (`reference_elastic_iac_migrated_to_gitlab_com`,
`reference_agent_knowledge_cached_per_process`).

## Files to modify

| File | Change | Commit |
|---|---|---|
| `agents/elastic-iac/agent.yaml` | repo url + project_id 82850717; model ids | 1, 2 |
| `agents/elastic-iac/SOUL.md` | repo name | 1 |
| `agents/elastic-iac/knowledge/mr-template.md` | primary target path | 1 |
| `agents/elastic-iac/knowledge/iac-repo-map.md` | path + id; add `environments/` tree; cluster list | 1, 2 |
| `packages/mcp-server-elastic-iac/src/config.ts` | `repository.projectId` fallback → 82850717 | 1 |
| `packages/gitagent-bridge/src/elastic-iac-load.test.ts` | assert 82850717 | 1 |
| `agents/elastic-iac/tools/elastic-iac.yaml` | prune dead actions/verbs; fix paths hint | 3 |
| `packages/mcp-server-elastic-iac/src/tools/gitlab.test.ts` (+ fixtures) | CI-artifact contract smoke test | 4 |
| `docs/elastic-iac-drift-report-contract.md`, `docs/configuration/*.md`, specs | stale path/id sweep | 5 |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pruning `tools/elastic-iac.yaml` actions changes agent behavior | Low | Verified zero references to removed actions/verbs in skills + `packages/agent/src` before removing |
| `elastic-iac-load.test.ts` numeric vs string id | Low | YAML loads `project_id` as a number; keep `.toBe(82850717)` numeric (matches current assertion type) |
| Smoke test can't reach trigger/poll closures | Medium | Closures inside `registerGitlabTools` do live `fetch`; test the **pure parsers** + a job-name guard instead. Refactor for injectable fetch is out of scope (noted). |
| Doc sweep over-corrects historical "pre-migration" notes | Low | Only correct lines asserting the dead id as *current*; leave dated "probed pre-migration" context intact |
| MCP server keeps stale config after change | Medium | Cold restart required; documented in Verification |

## Out of scope

- Refactoring trigger/poll functions for injectable `fetch` (enables true end-to-end tool tests) — separate ticket
- SIO-881 post-merge `apply:<cluster>:deployments` pipeline tracking
- New "create" skills (SLO/data-view/space/alert-rule creation) — all currently edit-only by design
- drift-report Increment 2 (`changes[]` leaf decomposition) — `docs/elastic-iac-drift-report-contract.md` §4
- Native GitLab MCP migration of the REST calls (`542f1eb` deferred intent)

## Memory references

- `reference_elastic_iac_migrated_to_gitlab_com` — SIO-891 migration; live id 82850717; two-target split; cold-restart caveat
- `reference_elastic_iac_ilm_policy_json_shape` — `environments/<cluster>/lifecycle-policies/<policy>.json` shape
- `reference_config_edit_workflow_recipe` — config-edit proposer touch-points + the gitagent-bridge skill-list canary
- `project_elastic_iac_agent_proposes_gitops_disposes` — propose-only model, full repo scope
- `reference_fleet_upgrade_subflow`, `reference_synthetics_drift_subflow` — the CI contracts the smoke test pins
- `reference_fixture_capture_recipe`, `feedback_extractor_fixtures_must_mirror_real_mcp` — fixture capture for the smoke test
- `reference_agent_knowledge_cached_per_process` — cold-restart requirement for agent definition/knowledge changes
