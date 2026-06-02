# SIO-880 — ilm-rollout as a single-MR GitOps proposer

- **Date**: 2026-06-02
- **Ticket**: [SIO-880](https://linear.app/siobytes/issue/SIO-880) (Backlog) — "elastic-iac: move ilm-rollout to the GitOps proposer"
- **Arc**: closes the elastic-iac GitOps proposer arc (SIO-870..879). ilm-rollout is the last workflow still on the legacy local-terraform `draftChange` path.
- **Predecessors**: [SIO-873](https://linear.app/siobytes/issue/SIO-873) (version-upgrade), [SIO-879](https://linear.app/siobytes/issue/SIO-879) (tier-resize) — this design mirrors both.
- **Handover**: `experiments/HANDOFF-2026-06-02-elastic-iac-gitops-proposer.md`
- **Suggested branch**: `sio-880-ilm-rollout-gitops-proposer` off `main`

## TL;DR

Add an `ilm-rollout` branch to the existing IaC GitOps proposer (`packages/agent/src/iac/`). One invocation edits ONE cluster's ILM policy JSON, deep-merges a phase-field patch, and opens ONE merge request via the GitLab REST API — reusing every node downstream of `draftChange` (`reviewPlan` -> `reviewGate` HITL -> `openMr` -> `watchPipeline` -> `teardown`) unchanged. Multi-wave choreography is the human re-invoking per cluster; no new graph nodes, no cross-wave state. Success = a natural-language ILM change ("set eu-b2b 30-days@lifecycle retention to 60 days, forcemerge warm to 1 segment") produces a real config-edit MR with the correct JSON diff, a HIGH-risk warning on any retention reduction, and a CI-computed plan on the MR. The agent never merges or applies.

## Context — how this ticket came to be

After SIO-873 (version-upgrade) and SIO-879 (tier-resize) moved to the GitOps proposer, ilm-rollout is the only workflow still routed through the legacy local-terraform path in `draftChange` (`packages/agent/src/iac/nodes.ts:507`). The authoritative model is the deck "Elastic Cloud Observability · IaC Monorepo" p.18 ("Agent proposes · GitOps disposes"): a change is a JSON config edit committed via the GitLab API; CI plans, a human merges and applies (maker/checker separation of duties).

### Ground truth established during design (corrects stale docs)

Probed live from `gitlab.siobytes.cloud/siobytes/elastic-iac`:

- ILM policies are **per-environment JSON files** at `environments/<cluster>/lifecycle-policies/<policy>.json` (one file per policy). The SIO-880 handover path claim is correct.
- The legacy `agents/elastic-iac/skills/add-ilm-policy/SKILL.md` and `agents/elastic-iac/knowledge/iac-repo-map.md` are **STALE**: they describe `stacks/<cluster>/ilm.tf` (Terraform HCL) and an `elasticstack_elasticsearch_index_lifecycle` resource. The repo migrated to per-env JSON config. Do not follow the HCL instructions. (Doc-sync is out of scope for this ticket — noted below.)
- **JSON shape** (verified against `eu-b2b/.../30-days@lifecycle.json` and `eu-cld/.../90-days@lifecycle.json`): top-level `name` plus phase keys at the **top level** (NOT nested under a `phases` object as the ticket guessed): `hot`, `warm`, `cold`, `delete`. Each phase is a flat settings object.

```json
{
  "name": "90-days@lifecycle",
  "hot":  { "max_age": "30d", "max_primary_shard_size": "50gb", "min_docs": 1, "rollover": true },
  "warm": { "min_age": "2d", "forcemerge": { "max_num_segments": 1 },
            "shrink": { "number_of_shards": 1, "allow_write_after_shrink": false } },
  "cold": { "min_age": "30d" },
  "delete": { "min_age": "90d", "delete_searchable_snapshot": true }
}
```

- **Retention = `delete.min_age`**. Reducing it is irreversible data loss once apply fires = HIGH risk.

Memory: `reference_elastic_iac_ilm_policy_json_shape`, `project_elastic_iac_gitops_proposer_model`.

## Design decisions (resolved during brainstorming)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Wave model | **Single-MR per invocation** | Mirrors version-upgrade/tier-resize; no new nodes/state; the human gate is re-invocation ("now do eu-cld"). The legacy `ilm-rollout.yaml` 4-wave choreography is NOT ported. |
| 2 | Edit scope | **General phase-field patch** (`mergeIlmPhases`) | Deep-merge a nested patch of only the changed fields into the policy JSON. Most flexible; the planner emitting a reliable nested patch is the hard part. |
| 3 | Policy resolution | **Resolve + verify-exists, MODIFY-only** | New `ELASTIC_IAC_ILM_POLICY_TEMPLATE` (default `environments/${cluster}/lifecycle-policies/${policy}.json`); 404 -> clean block. Creating new policies is out of scope. |
| 4 | Retention reduction | **HIGH-risk warning, never auto-block** | `guards.ts` stays mechanical-only; the reduction is surfaced in the review card + MR body, the human approves at the HITL gate, CODEOWNERS gates merge. Maker/checker SoD. |

## Architecture

Mirrors the SIO-879 tier-resize migration. The **only** edits to graph wiring are one route line in `draftChange`. Everything from `reviewPlan` onward is reused.

```
START -> bootstrap -> classifyIacIntent
  classifyIacIntent --(gitops)--> parseIntent -> readClusterState -> guard
     guard --> draftChange
        draftChange --(workflow==="version-upgrade")--> proposeVersionUpgrade   (existing)
        draftChange --(workflow==="tier-resize")------> proposeTierResize        (existing)
        draftChange --(workflow==="ilm-rollout")------> proposeIlmChange         <-- NEW
        draftChange --(other)--> legacy terraform draft                          (existing)
        draftChange --(blocked)--> END
        draftChange -> reviewPlan -> reviewGate (HITL iac_plan_review)
           reviewGate --(approved)--> openMr -> watchPipeline -> teardown -> END
           reviewGate --(rejected)--> teardown -> END
```

No new graph nodes. No new MCP tools (`gitlab_get_file_content` / `gitlab_create_branch` / `gitlab_commit_file` already serve any file path; verified live during design).

## Components

### 1. Intent fields — `state.ts` + `nodes.ts`

`IacRequest` (`packages/agent/src/iac/state.ts:5`) gains:

```ts
// SIO-880: nested phase patch for an ilm-rollout change, e.g.
// { warm: { forcemerge: { max_num_segments: 1 } }, delete: { min_age: "60d" } }.
phasesPatch?: Record<string, unknown>;
```

`policyName` already exists. `IntentSchema` (`nodes.ts:47`) gains `phasesPatch: z.record(z.string(), z.unknown()).nullish()`, normalized to `undefined` in `parseIntentJson` like every other optional.

`parseIntent`'s planner instruction (`nodes.ts:149`) gains an ilm-rollout clause:

> For an ILM lifecycle-policy change ("set eu-b2b 30-days retention to 60 days", "forcemerge warm to 1 segment on eu-cld logs"), set `workflow` to `'ilm-rollout'`, `cluster` to the named deployment, `policyName` to the policy filename **verbatim** (e.g. `30-days@lifecycle`, `logs`, `eu-default-lifecycle-logs-prod`), and `phasesPatch` to a nested object containing **only** the phase fields to change (top-level keys are phases: hot/warm/cold/delete; durations are strings like `"60d"`). Set `clarification` when the cluster, policy, or any field is genuinely missing.

### 2. `mergeIlmPhases(json, patch)` — pure, exported, unit-tested (`nodes.ts`)

```ts
// SIO-880: read-modify-write an ILM policy JSON by deep-merging a nested phase patch.
// Recurses into nested objects (warm.forcemerge), replaces scalars and arrays. Captures
// the pre-merge value of every touched leaf into `previous` (for the diff + reduction
// check). Preserves 2-space indent + trailing newline. Throws on non-object JSON.
export function mergeIlmPhases(
  json: string,
  patch: Record<string, unknown>,
): { content: string; previous: Record<string, unknown> };
```

`previous` is a sparse mirror of `patch` holding the old leaf values (e.g. `{ delete: { min_age: "90d" } }`). Deep-merge rule: object-into-object recurses; everything else (scalar, array, null) replaces.

### 3. `detectRetentionReduction(previous, patch)` — pure, exported (`nodes.ts`)

```ts
// SIO-880: compare old vs new delete.min_age. Returns the descriptor when the new
// retention is strictly shorter, else null. Parses "<N><unit>" durations (d/h/m/s ->
// seconds) so 48h < 3d compares correctly; returns null on an unparseable/absent value.
export function detectRetentionReduction(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): { from: string; to: string } | null;
```

### 4. `ilmPolicyTemplate()` + path resolution (`nodes.ts`)

```ts
// Lazy env read (no module-scope Bun.env; the web app runs Vite SSR).
function ilmPolicyTemplate(): string {
  return process.env.ELASTIC_IAC_ILM_POLICY_TEMPLATE
    ?? "environments/${cluster}/lifecycle-policies/${policy}.json";
}
```

`deploymentJsonPath(template, cluster)` (`nodes.ts:341`) is generalized to also substitute `${policy}`: add an optional `policy` arg and a second `.replace(/\$\{policy\}/g, policy)`. The policy filename is used verbatim (it legitimately contains `@`/`.`).

### 5. `proposeIlmChange(state, req)` — node-level (not exported), mirrors `proposeTierResize` (`nodes.ts:440`)

Sequence:
1. Guard: missing `policyName` or empty/absent `phasesPatch` -> block "name the policy and at least one phase field to change."
2. Resolve `filePath` from `ilmPolicyTemplate()` + cluster + policy; compute `branch` via `branchName(req)`.
3. `gitlab_get_file_content`: token-missing -> block; 404 -> block "no such policy `<policy>` on `<cluster>`."
4. `mergeIlmPhases(extractFileContent(raw), req.phasesPatch)`; JSON parse failure -> block.
5. `detectRetentionReduction(previous, patch)` -> `retentionChange` state.
6. `gitlab_create_branch` + `gitlab_commit_file` (message: `<cluster>: ILM <policy> — <summary of changed fields>`).
7. Build a human diff string (per touched leaf: `- "min_age": "90d"` / `+ "min_age": "60d"`).
8. Return `branch`, `proposedFilePath`, `proposedDiff`, `precheckPassed`, `retentionChange`.

### 6. `branchSlug` extension (`nodes.ts:348`)

```ts
const descriptor =
  req.workflow === "version-upgrade" ? req.version
  : req.workflow === "ilm-rollout"   ? req.policyName
  : (req.tier ?? req.resource);
```

Yields `agent/<cluster>-<policy>-ilm-rollout-<date>` (the slug regex strips `@`/`.`).

### 7. State field — `state.ts`

```ts
// SIO-880: when an ilm-rollout reduces delete.min_age, the from/to surfaced as a
// HIGH-risk line in the review card + MR body (data deletion is irreversible).
retentionChange: Annotation<{ from: string; to: string } | null>({ reducer: last, default: () => null }),
```

### 8. `reviewPlan` wiring (`nodes.ts:526`)

- Extend `isConfigEdit` to include `ilm-rollout` (so it takes the "CI computes the plan on the MR" path; no local terraform).
- `risks[]` additions:
  - Always (ilm-rollout): "ILM phase change can trigger force-merge load / frozen pull-in; transitions take effect as each index rolls over, not immediately."
  - When `state.retentionChange` set: prepend HIGH line "Retention REDUCED `<from>`->`<to>`; data deleted at apply is irrecoverable — confirm the IR/issue reference before merge."
- Descriptor for the title: `<policyName>: <changed-field summary>`.

### 9. `buildMrDescription` wiring (`nodes.ts:627`)

- Add an ilm-rollout context clause (policy name, the field changes, retention delta).
- `categoryRisk`: `Category ilm, Risk MEDIUM`, or `Category ilm, Risk HIGH` when `retentionChange` is set.

## Configuration

New env var, documented in `.env.example` next to `ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE`:

```
# SIO-880: agent-side path template for ILM lifecycle-policy JSON. ${cluster}/${policy}
# are literal placeholders the agent substitutes (not JS template literals).
ELASTIC_IAC_ILM_POLICY_TEMPLATE=environments/${cluster}/lifecycle-policies/${policy}.json
```

## Error handling

All paths degrade with a user-facing `AIMessage` + `blockedReason`; none throw (matches `proposeTierResize`).

| Failure | Handling |
|---|---|
| `ELASTIC_IAC_GITLAB_TOKEN` missing | block — same message as `proposeTierResize` |
| Policy file 404 | block: "no such policy `<policy>` on `<cluster>`" |
| Policy JSON unparseable | block: "`<path>` did not parse as JSON" |
| `phasesPatch` empty/missing | block: "name the policy and at least one phase field to change" |
| commit 4xx/5xx | `precheckPassed=false`; surfaced in the review (existing) |
| MCP server down | `callTool` placeholder -> block (existing) |

## Testing

Verification bar: `bun run typecheck && bun run lint && bun run yaml:check && bun test packages/agent/src/iac`.

### Unit (pure helpers — the bulk of the coverage)

- `mergeIlmPhases`: deep-merge a nested field (`warm.forcemerge.max_num_segments`), scalar replace (`delete.min_age`), multi-phase patch in one call, `previous` capture of every touched leaf, 2-space indent + trailing newline preserved, throws on non-object JSON.
- `detectRetentionReduction`: `90d->30d` is a reduction, `30d->60d` is not, `48h < 3d` compares correctly, missing `delete` in patch -> null, unparseable duration -> null.
- `parseIntentJson`: ilm-rollout shape with a `phasesPatch` object; explicit-null `phasesPatch` normalized to undefined; unknown workflow falls back to clarify.
- `branchSlug`: ilm-rollout descriptor with `@`/`.` in the policy name slugged correctly.
- path resolution: `${cluster}` + `${policy}` both substituted; policy `@`/`.` preserved verbatim.

### Node-level (mocked `callTool`)

- `proposeIlmChange`: happy path (returns branch/diff/precheckPassed); each block branch (missing token, 404 policy, bad JSON, empty patch); `retentionChange` set on a reduction, null otherwise.

New tests go in a new `packages/agent/src/iac/ilm-rollout.test.ts` (per-workflow convention — `version-upgrade.test.ts` already holds the version + tier-resize cases; ILM gets its own file rather than growing that one further). Import the pure helpers from `./nodes.ts` exactly as `version-upgrade.test.ts` does.

### Live e2e (manual; after a COLD web restart — see Risks)

Switch to the elastic-iac agent -> ILM retention change on a **non-prod** policy (e.g. gl-testing or a dev policy) -> approve at the HITL gate -> watch the ticker -> verify the MR shows the correct JSON diff + Risk HIGH + CI plan. **Close the MR (`PUT .../merge_requests/<iid>?state_event=close`) and delete the branch (`DELETE .../repository/branches/<encoded>`) afterward.** `main` policy JSONs must stay untouched.

## Files to modify

| File | Change |
|------|--------|
| `packages/agent/src/iac/state.ts` | `IacRequest.phasesPatch`; `retentionChange` annotation |
| `packages/agent/src/iac/nodes.ts` | `IntentSchema`+`parseIntentJson` ilm fields; `parseIntent` planner clause; `mergeIlmPhases`; `detectRetentionReduction`; `ilmPolicyTemplate`; `deploymentJsonPath` `${policy}`; `proposeIlmChange`; `draftChange` route; `branchSlug`; `reviewPlan` risks + `isConfigEdit`; `buildMrDescription` clause |
| `packages/agent/src/iac/ilm-rollout.test.ts` (new) | all unit + node-level tests above |
| `.env.example` | `ELASTIC_IAC_ILM_POLICY_TEMPLATE` |
| `agents/elastic-iac/RULES.md` | one line: ilm-rollout is now a JSON edit at `environments/<cluster>/lifecycle-policies/<policy>.json` (alongside the existing version/tier lines) |
| `agents/elastic-iac/tools/elastic-iac.yaml` | confirm the `propose` action already exposes the gitlab file/branch/commit tools to ilm-rollout (no new tool; verify mapping) |
| `docs/architecture/agent-pipeline.md` | note ilm-rollout joined the config-edit proposers (if the IaC graph is documented there) |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Planner emits a malformed/over-broad `phasesPatch` | Medium | `phasesPatch` is `.nullish()`+normalized; empty/absent -> block; the human reviews the exact JSON diff at the HITL gate before any MR is approved |
| Stale agent definition cached -> ILM intent not recognized | Medium | COLD web restart required for `agents/elastic-iac/**` + graph changes (`bun --hot` doesn't re-resolve). Memory: `reference_agent_knowledge_cached_per_process` |
| Policy filename casing/`@` mismatch -> 404 | Medium | verbatim filename + clean 404 block message; verify-exists decision (#3) |
| Retention reduction approved without justification | Low | HIGH-risk line in card + MR; CODEOWNERS gates merge; agent never applies (#4) |
| `deployments` stack single shared state lock | Low | reuse SIO-878 `classifyPipelineFailure`; don't fire concurrent test MRs; clean up |
| Duration comparison across units (48h vs 3d) | Low | `detectRetentionReduction` normalizes to seconds; unit-tested |

## Out of scope (explicit)

- **Multi-wave choreography** (gl-testing -> dev -> stg -> prod in one invocation). The human re-invokes per cluster. Hook point for a future ticket: a loop over `clusters_in_order` with a per-wave `iac_wave_gate` interrupt + `waveIndex`/`waveMrIids` state. Tracked as a follow-up, not SIO-880.
- **Creating new ILM policies** (modify-only this ticket).
- **Adding/removing whole phase blocks** (field edits within existing phases only; phase add/remove carries extra force-merge/frozen-pull-in risk).
- **Migrating the stale `add-ilm-policy` skill + `iac-repo-map.md` off the HCL model** — separate doc-sync (reuses this ticket per the doc-sync rule, no new Linear issue).
- The agent never approves, merges, or triggers apply (DUTIES — human/CI only).

## Related code references (reference patterns)

- `packages/agent/src/iac/nodes.ts:440` — `proposeTierResize` (closest template).
- `packages/agent/src/iac/nodes.ts:315` — `setDeploymentTierSize` (read-modify-write JSON; `previous*` capture idiom).
- `packages/agent/src/iac/nodes.ts:341` — `deploymentJsonPath` (`${cluster}` substitution to generalize).
- `packages/agent/src/iac/nodes.ts:526` — `reviewPlan` (`isConfigEdit` + `risks[]`).
- `packages/agent/src/iac/nodes.ts:627` — `buildMrDescription` (category/risk clause).
- `packages/agent/src/iac/guards.ts:12` — `evaluateGuards` (stays mechanical-only; no ILM branch).

## Memory references

`reference_elastic_iac_ilm_policy_json_shape`, `project_elastic_iac_gitops_proposer_model`, `reference_agent_knowledge_cached_per_process`, `reference_no_module_scope_bun_env_in_agent`, `reference_bun_hot_does_not_reresolve_modules`, `feedback_guides_not_in_repo`.
