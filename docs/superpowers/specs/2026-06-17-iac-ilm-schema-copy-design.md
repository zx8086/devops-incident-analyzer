# elastic-iac ILM: correct policy shape, copy-from-reference, structural validation, cluster de-bias

- **Date:** 2026-06-17
- **Repo state:** branch `SIO-931-iac-ilm-schema-copy` off `origin/main` HEAD `7aba94a`
- **Status:** approved (brainstorming) — pending implementation plan
- **Linear:** [SIO-931](https://linear.app/siobytes/issue/SIO-931)

## TL;DR

The elastic-iac agent emits ILM policy JSON in an **invented flat shape** that matches neither live Elasticsearch nor the GitOps repo, so `terraform plan` rejects it in CI (`attribute "frozen": attribute "searchable_snapshot" is required`). It also cannot honor "make an exact copy of `<policy>`" (no reference-read path), and it anchors on `eu-b2b` (the only cluster in ~15 prompt examples) when the user names a different cluster. A real session took ~5 rounds and still produced a CI-failing file. This fixes all four in one PR: (A) shape the proposer's output from a real repo policy (lookup, not invention), (B) a pre-commit structural validator mirroring the TF module, (C) a `sourcePolicy` copy-from-reference path, (D) cluster de-biasing in the prompt.

## Context — how this came to be

Follow-on from SIO-930 (conversational follow-ups, merged in #224). While testing the IaC agent on a real us-cld ILM task ("replace `logs@lifecycle` with an exact copy of `us-default-lifecycle-logs-prod`"), the CI job [14890759369](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/jobs/14890759369) failed `terraform plan` with `module.lifecycle_policies.var.policies ... element "logs@lifecycle": attribute "frozen": attribute "searchable_snapshot" is required`. The agent had written flat `searchable_snapshot_repository`; the module requires a nested `searchable_snapshot` object.

## Ground truth (verified against the live repo)

The repo is checked out at `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/`.

**Module schema** (`modules/lifecycle/variables.tf`) — the policy is `map(object({...}))` with deeply nested phases. Required nesting:
- `hot.priority` (number) — NOT `set_priority`
- `warm.allocate.number_of_replicas`, `warm.forcemerge.max_num_segments`, `warm.shrink.number_of_shards` (+ optional `allow_write_after_shrink`)
- `cold.allocate.number_of_replicas`
- `frozen.searchable_snapshot.{snapshot_repository, force_merge_index?}` — `searchable_snapshot` is REQUIRED when `frozen` is present
- `delete.{min_age?, delete_searchable_snapshot?, wait_for_snapshot.{policy}?}`
- All phases are `optional(..., null)`; partial policies are valid.

**A real, CI-valid policy** (`environments/us-cld/lifecycle-policies/us-default-lifecycle-logs-prod.json`) — the exact file the user asked to copy:
```json
{ "name": "us-default-lifecycle-logs-prod",
  "hot": { "priority": 100, "max_age": "7d", "max_primary_shard_size": "10gb", "rollover": true },
  "warm": { "min_age": "6h", "priority": 50, "allocate": { "number_of_replicas": 0 },
            "forcemerge": { "max_num_segments": 1 }, "shrink": { "number_of_shards": 1, "allow_write_after_shrink": false } },
  "cold": { "min_age": "2d", "priority": 25, "allocate": { "number_of_replicas": 0 } },
  "frozen": { "min_age": "7d", "searchable_snapshot": { "snapshot_repository": "found-snapshots", "force_merge_index": true } },
  "delete": { "min_age": "60d", "delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } } }
```

**The agent's invented shape vs ground truth:**

| Field | Repo (correct) | Agent emitted (CI-failing) |
|---|---|---|
| priority | `hot.priority: 100` | `hot.set_priority` |
| warm replicas | `warm.allocate.number_of_replicas: 0` | `warm.number_of_replicas` |
| forcemerge | `warm.forcemerge.max_num_segments: 1` | `warm.forcemerge_max_num_segments` |
| shrink | `warm.shrink.number_of_shards: 1` | `warm.shrink_number_of_shards` |
| cold replicas | `cold.allocate.number_of_replicas: 0` | `cold.number_of_replicas` |
| frozen snapshot | `frozen.searchable_snapshot: { snapshot_repository, force_merge_index }` | `frozen.searchable_snapshot_repository` + `frozen.force_merge_index` |
| delete SLM | `delete.wait_for_snapshot: { policy }` | `delete.wait_for_snapshot_policy` |
| delete flag | `delete.delete_searchable_snapshot: true` | same (already correct) |

Two lookup sources exist but only one matches CI:
- `elastic_ilm_get_lifecycle` (live ES) → ES-native `phases.<phase>.actions.<action>` shape + `set_priority`. **Wrong reference** for a repo file.
- `gitlab_get_file_content` (repo) → the nested shape above. **This is the CI-valid shape.** → drive correctness from the repo.

## Where the bodies are buried

- `packages/agent/src/iac/nodes.ts:421` — parseIntent instruction calls the shape a "FLAT phase DSL" with a flat example (origin of the invented shape).
- `packages/agent/src/iac/nodes.ts:1696` — `proposeIlmChange`: builds a new policy as `mergeIlmPhases(JSON.stringify({name}), patch)` (line 1738) — patch-only, no reference read, no validation.
- `packages/agent/src/iac/nodes.ts` `mergeIlmPhases` — deep-merge, **shape-agnostic and correct**; no change needed.
- `packages/agent/src/iac/nodes.ts:1034` — `ilmPolicyTemplate()` = `environments/${cluster}/lifecycle-policies/${policy}.json` (reused for the source/sibling read).
- `packages/agent/src/iac/nodes.ts:5102` — `gitlab_get_repository_tree` + `parseRepoTreeDirs` (used to list sibling policies for the from-scratch template).
- `packages/agent/src/iac/nodes.ts:231-241, 415-454` — ~15 `eu-b2b`-only prompt examples (cluster anchor).
- `packages/agent/src/iac/ilm-rollout.test.ts:58` — a fixture asserting the invented `set_priority` shape (rewrite to nested).
- `agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md`, `10-quick-reference.md` — examples in ES-native/invented shapes (align to repo shape).

## Part A — Repo lookup drives the policy shape

`proposeIlmChange` no longer invents structure. It obtains a correctly-shaped **base** from the repo, then merges the LLM's overrides onto it:

- **Copy (`sourcePolicy` set):** the base is the source policy JSON (Part C).
- **From-scratch (no `sourcePolicy`, target is 404/new):** read a **sibling** policy in the same cluster's `lifecycle-policies/` dir as a structural template:
  - List the dir via `gitlab_get_repository_tree` (path `environments/<cluster>/lifecycle-policies`); pick a template by preference order `ELASTIC_IAC_ILM_TEMPLATE_POLICY` env → `basic-lifecycle-logs.json` if present → the first `*.json` that is not the target.
  - Read it, strip its `name`, set the target `name`, use as base, merge `phasesPatch` on top.
  - **No sibling exists** (e.g. `gl-testing`/`eu-onboarding` have no `lifecycle-policies/` dir): fall back to a hardcoded canonical nested skeleton (`CANONICAL_ILM_SHAPE`, mirroring `us-default-lifecycle-logs-prod`), merge `phasesPatch`, and rely on Part B to catch any gap. Log that the fallback was used.
- **Modify (target exists):** unchanged — read the target, merge `phasesPatch` (existing path); Part B validates the result.

The parseIntent ILM instruction (nodes.ts:421-425) is rewritten to teach the **repo nested shape** with `us-default-lifecycle-logs-prod` as the example, and to enumerate the nesting rules explicitly (priority not set_priority; allocate/forcemerge/shrink/searchable_snapshot/wait_for_snapshot nested). The prompt is no longer the sole source of truth — the repo base is — but correct examples ensure the LLM's override *values* land in the right nested slots.

## Part B — Structural validator (pre-commit gate)

New pure `validateIlmPolicy(policy: unknown): { ok: true } | { ok: false; reason: string }` in `nodes.ts`, a Zod schema mirroring `variables.tf`:
- top-level `name: string`, optional `metadata: string`.
- each phase optional; within a present phase, the nested objects are required where the module requires them (notably `frozen.searchable_snapshot.snapshot_repository`); `.strict()` at the phase level so an unknown key (the flat mistakes) is rejected, not silently ignored.
- A pre-check scans for the **known flat mistakes** and produces a targeted message naming the nested fix, e.g.:
  - `searchable_snapshot_repository` → "frozen.searchable_snapshot must be a nested object { snapshot_repository, force_merge_index }, not a flat searchable_snapshot_repository".
  - `set_priority` → "use `priority` (number) on the phase, not `set_priority`".
  - bare `number_of_replicas` on warm/cold → "use `allocate: { number_of_replicas }`".
  - `forcemerge_max_num_segments` / `shrink_number_of_shards` → nested `forcemerge.max_num_segments` / `shrink.number_of_shards`.
  - `wait_for_snapshot_policy` → "use `wait_for_snapshot: { policy }`".

`proposeIlmChange` runs `validateIlmPolicy(merged)` **after merge, before `gitlab_create_branch`/commit**. On `ok:false` it returns `blockedReason` + a user-facing AIMessage with the precise structural error and does NOT open an MR. This is the loop-closer: a malformed policy never reaches CI.

## Part C — Copy-from-reference

- **`sourcePolicy?: string`** on `IacRequest` (`state.ts`) + `IntentSchema` (`.nullish()`) + the `parseIntentJson` `nn()` normalizer (atomic with the schema).
- parseIntent instruction: "If the user asks to copy / clone / mirror / 'same as' / 'exact copy of' an existing policy, set `sourcePolicy` to that policy's filename verbatim and put ONLY the explicit overrides (if any) in `phasesPatch`. The cluster is still the TARGET deployment."
- `proposeIlmChange` copy branch (runs before the from-scratch/modify logic when `sourcePolicy` is set):
  - `raw = gitlab_get_file_content(environments/<cluster>/lifecycle-policies/<sourcePolicy>.json)` — **same cluster**.
  - Not `isGitlabSuccess` → **block**: "I couldn't read reference policy `<sourcePolicy>` on `<cluster>` (`<status>`). Name an existing policy to copy, or specify the phases directly." (404 and auth/5xx both block — copying requires a real source.)
  - Success → parse, set `name` = target `policyName`, base = that object, `updated = mergeIlmPhases(base, phasesPatch ?? {})`, `policyCreated = target file is 404`.
  - Run Part B validator; commit; the diff renders source→target leaf changes (overrides) plus, for a new target, the full policy as additions.
- Review card / MR summary: when `sourcePolicy` set, "ILM `<policy>` — exact copy of `<sourcePolicy>`" + any overrides (e.g. "delete.min_age 60d").

## Part D — Cluster de-biasing

- Rotate the example cluster names across the ~15 prompt strings (nodes.ts:231-241, 415-454) among `eu-b2b` / `us-cld` / `ap-cld` / `eu-cld` so no single name dominates the context.
- Add to the parseIntent instruction: "Extract `cluster` ONLY from the deployment the user names in their request. Never default to a cluster from these examples; if the user names no cluster, set `clarification` to ask which deployment." (`us-cld` is a valid cluster per `cluster-inventory.md`; resolution already handles it — the failure was extraction, not resolution.)

## Testing

`packages/agent/src/iac/` (Bun):
- **Copy path** (`proposeIlmChange`, mocked `gitlab_get_file_content`): copying `us-default-lifecycle-logs-prod` with override `{delete:{min_age:"60d"}}` → committed content is the full nested policy with `delete.min_age:"60d"`; **validator passes** (the exact CI-failing scenario, now correct). Source 404 → blocks, no branch/commit. Source 5xx → blocks.
- **From-scratch template path**: target 404, sibling `basic-lifecycle-logs.json` present (mocked tree + content) → output mirrors the sibling's nesting with overrides; no-sibling → `CANONICAL_ILM_SHAPE` fallback + validator passes.
- **`validateIlmPolicy`**: REJECTS each flat mistake with a message naming the nested fix (`searchable_snapshot_repository`, `set_priority`, bare warm/cold `number_of_replicas`, `forcemerge_max_num_segments`, `shrink_number_of_shards`, `wait_for_snapshot_policy`); ACCEPTS the three real repo policies (committed as fixtures) and a sparse `{name, delete:{min_age}}` policy.
- **`parseIntentJson`**: "copy X to Y" → `{sourcePolicy:"X", policyName:"Y"}`; a plain change still has `sourcePolicy: undefined`.
- **Rewrite** existing ILM fixtures that assert the invented flat shape (e.g. ilm-rollout.test.ts:58 `set_priority`) to the nested repo shape.

Cluster de-bias is prompt-only (LLM-driven) — covered by the manual probe, not a unit test.

## Verification

```bash
bun run typecheck && bun run lint && bun test packages/agent/src/iac/
```

Manual probe (replay the real failure; web on a worktree port, IaC MCP on :9086):
```bash
# copy + override, on us-cld (NOT eu-b2b)
curl -sN localhost:<port>/api/agent/stream -H 'content-type: application/json' -d '{
  "agentName":"elastic-iac","threadId":"sio931-probe",
  "messages":[{"role":"user","content":"On us-cld, replace the logs@lifecycle ILM policy with an exact copy of us-default-lifecycle-logs-prod, keeping delete.min_age at 60d."}]
}' | grep -E 'classified|intent|cluster'
# expect: cluster us-cld; sourcePolicy us-default-lifecycle-logs-prod; review card shows a nested policy; validator passes.
```
Optionally push the resulting MR branch and confirm CI `terraform plan` succeeds (the real acceptance test).

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/iac/state.ts` | `sourcePolicy?: string` on `IacRequest` |
| `packages/agent/src/iac/nodes.ts` | `IntentSchema.sourcePolicy` + `parseIntentJson` normalizer; parseIntent ILM instruction (nested shape + sourcePolicy + cluster rule); `proposeIlmChange` copy branch + from-scratch template lookup + fallback; `validateIlmPolicy` + `CANONICAL_ILM_SHAPE`; validator call pre-commit; rotate example clusters; MR/review summary for copy |
| `packages/agent/src/iac/*.test.ts` | new copy/validator/template tests; rewrite invented-shape fixtures |
| `agents/elastic-iac/knowledge/playbook/3-index-lifecycle-management-ilm.md`, `10-quick-reference.md` | align ILM examples to the repo nested shape |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sibling template itself is malformed/old shape | Low | Part B validates the merged result regardless of base source |
| `gitlab_get_repository_tree` unavailable / dir empty | Med | `CANONICAL_ILM_SHAPE` fallback + validator; log fallback |
| Validator too strict, rejects a valid sparse policy | Med | Mirror `optional()` from variables.tf exactly; fixtures include a sparse policy and all 3 real ones |
| LLM still emits a flat override despite corrected prompt | Med | Validator blocks pre-commit with a targeted nested-fix message |
| Modify path (existing target already flat in repo) | Low | Out of scope to rewrite existing files; validator runs on the merged result and will flag a pre-existing flat file so the human sees it |
| cluster still mis-extracted | Low | de-bias + explicit rule + cluster shown on the review card before MR |

## Out of scope

- Cross-cluster copy (source must be the same deployment as the target).
- Non-ILM resources (SLO/dashboard/etc. shapes).
- Transforming the live-ES `phases.X.actions.X` shape into the repo shape.
- Any change to `modules/lifecycle` or other Terraform module code.
- Rewriting existing already-committed flat policy files in the repo (separate cleanup if any exist).
- The SIO-930 converse work (shipped).

## Memory references

- `reference_elastic_iac_ilm_policy_json_shape` — ILM lives at `environments/<cluster>/lifecycle-policies/<policy>.json` (UPDATE: this memory says "flat phase DSL" — it is being corrected by this work; the real shape is nested-object).
- `reference_iac_ilm_e2e_validated` — only eu-b2b/eu-cld/ap-cld/us-cld have `lifecycle-policies/`; gl-testing + eu-onboarding don't (drives the no-sibling fallback).
- `project_elastic_iac_agent_proposes_gitops_disposes` — propose-only; CI plans/applies; real repo checkout path.
- `reference_iac_agent_no_conversational_memory` — SIO-930 context (sibling work, merged).
