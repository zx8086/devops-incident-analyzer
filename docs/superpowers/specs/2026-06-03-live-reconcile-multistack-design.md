# Reconcile-to-Live for Kibana-backed stacks — design

- Status: Approach **B** selected (2026-06-03). elastic-iac side DELIVERED (commit `0f845a3`); agent-side foundation (drift-report `values` parsing) landed. See the Update section at the end.
- Date: 2026-06-03
- Ticket: SIO-XXX (to be created/linked)
- Related: PR #186 (generalized reconcile-to-live within the deployment + ILM JSON families), `docs/superpowers/specs/2026-06-02-elastic-iac-agent-design.md`, `docs/superpowers/specs/2026-06-02-ilm-rollout-gitops-proposer-design.md`

## Problem

In the IaC drift UI, every drifted stack is offered **Reconcile to GitLab** + **Do Nothing**, but **Reconcile to Live Deployment** appears only for two stacks (`deployments`, `lifecycle-policies`). Operators reasonably expect both reconcile directions for *every* drift, because in the elastic-iac repo **all 24 stacks are JSON-config-driven** (`environments/<deployment>/<stack>/*.json`; the `.tf` is generic module logic via `jsondecode(file(...))` + `for_each`).

The asymmetry is real but is **not** a property of the repo:

- **Reconcile to GitLab** (`reconcile-to-json`) is universal: it writes a marker file whose merge re-runs the stack's `terraform plan`/apply to revert live drift back to declared. No source rewrite, so it works for any stack.
- **Reconcile to Live** (`reconcile-to-live`) rewrites the repo *source file* to match live. It is wired for only two stacks, and the agent mislabels every other stack as `kind: "hcl"` (a misnomer — they are JSON-config stacks the agent simply has not wired).

## Current state (the per-stack contract)

Reconcile-to-live needs three things wired per stack. Today only the `deployment` and `ilm` families have all three:

| Requirement | `deployments` | `lifecycle-policies` | other 22 stacks |
|---|---|---|---|
| 1. Editable file-path template | `ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE` -> `environments/_deployments/<cluster>.json` | `ELASTIC_IAC_ILM_POLICY_TEMPLATE` -> `environments/<cluster>/lifecycle-policies/<policy>.json` | exist on disk, **no template configured** |
| 2. Live reader (MCP tool) | `elastic_cloud_get_deployment` | `elastic_ilm_get_lifecycle` | **none wired** |
| 3. Live -> repo-JSON projection | `extractLiveTopology` / `applyLiveTopology` | `liveIlmToRepoShape` / `ilmRepoShapeToFile` | **none written** |

Relevant code (`packages/agent/src/iac/`):

- `nodes.ts:classifyStackByName` — hardcoded `if (family==="deployment") … if (family==="ilm") … return { kind: "hcl", liveReconcilable: false }`. Name-allowlist driven (`configDeploymentStacks` / `configIlmStacks`).
- `nodes.ts:driftCheckStack` (~line 2008) — narrows the static capability to the actual drifted keys: `liveReconcilable = deploymentLiveKeys.length > 0 || ilmLiveReconcilable`.
- `nodes.ts:buildLiveReconcile` (line 1646) — dispatches by family to `buildLiveDeploymentReconcile` / `buildLiveIlmReconcile`. Each: resolve path(s) -> live read -> repo read (`gitlab_get_file_content`) -> project -> empty-diff guard -> `{ files: [{path,content}], summary, note? }` or `{ blocked }`.
- `nodes.ts:openReconcileMr` (line 1745) — idempotent branch (`reconcileBranch`), commit file(s), open MR; reuses an existing open agent MR on the deterministic branch.
- `state.ts` — `ReconcileDirection = "reconcile-to-json" | "reconcile-to-live" | "skip"`; `StackDrift.liveReconcilable: boolean`.
- `nodes.ts:reconcileGate` (line 2176) — `directions = liveReconcilable ? ["reconcile-to-live","reconcile-to-json","skip"] : ["reconcile-to-json","skip"]`.

### Two hard findings (feasibility)

1. **No Kibana read capability exists anywhere in the monorepo.** The elastic MCP server exposes only Elasticsearch cluster/cloud tools (`cluster`, `ilm`, `index_management`, `search`, `transform`, `watcher`, `cloud`, `billing`, …). The two working stacks work because their live state comes from ES/EC APIs, not Kibana. The candidate stacks (`dataviews`, `alerting`, `agent-policies`, `fleet-integrations`, …) are **Kibana** resources.
2. **The agent never sees live values.** It receives only the reduced `drift-report.json` (`gitlab_get_drift_check_result` -> `{status, report, failureLog}`), and `parseDriftReport` keeps only `changedKeys` (names), not before/after values. Live values exist only in the full `terraform plan`, which stays in CI.

So "add a projection" is insufficient — each new stack needs a **live-state source** that does not exist yet. That is the central decision below.

## Goals / non-goals

Goals:
- A registry-driven design so adding a stack to reconcile-to-live is a single declarative entry, not new branching.
- Ship one stack end-to-end (`dataviews`) as the proving pattern.
- Fix the `kind: "hcl"` misnomer so the UI/logs never imply a JSON-config stack is Terraform.

Non-goals:
- HCL/Terraform code generation (not involved — this is JSON-in/JSON-out).
- Auto-merge or auto-apply (unchanged: the agent only ever opens MRs).
- Reconciling all 22 stacks at once (incremental, value-ordered).

## Common design (independent of A vs B): a family registry

Replace the hardcoded family dispatch with a registry. Each entry encapsulates the three requirements:

```ts
interface LiveReconcileFamily {
  name: string;                                   // "deployment" | "ilm" | "dataviews" | ...
  stacks: () => Set<string>;                      // env allowlist (ELASTIC_IAC_CONFIG_*_STACKS)
  filePath: (deployment: string, key?: string) => string;       // template resolver
  reconcilableKeys: (stack: StackDrift) => string[];            // which drifted keys/resources this family handles
  readLive: (deployment: string, key?: string) => Promise<string>;  // <-- the A/B difference lives here
  project: (live: string, repoFile: string, key?: string) =>
    { content: string } | null;                  // live -> repo-JSON shape (per-file empty-diff via === check)
  lostActions?: (live: string) => string[];       // optional caveat surfaced in the MR body
}
```

- `classifyStackByName` becomes a registry lookup; the terminal `kind: "hcl"` branch becomes `kind: "terraform-only"` (or `"unwired"`) with a clear meaning: "no live-reconcile family registered."
- `buildLiveReconcile` iterates the matched family's `reconcilableKeys`, calling `readLive` + `project` per key, accumulating `files[]` with the existing empty-diff guard and `note` aggregation. `buildLiveDeploymentReconcile` / `buildLiveIlmReconcile` become two registry entries with no behavior change.
- `driftCheckStack` narrowing generalizes to `reconcilableKeys(stack).length > 0`.
- `reconcileGate` / labels unchanged structurally; only the absence-reason copy improves.

This refactor is **shared by both approaches** and is the bulk of the agent-side work; A vs B only changes each family's `readLive`.

## Approach A — Kibana readers in the MCP server

Add a `kibana` tool category to `mcp-server-elastic` (or a thin new `mcp-server-kibana`) with read-only tools:

- `kibana_get_data_views` (`GET /api/data_views`) — first increment.
- later: `kibana_find_alerting_rules` (`GET /api/alerting/rules/_find`), `kibana_get_agent_policies` (`GET /api/fleet/agent_policies`), `kibana_get_package_policies` (`GET /api/fleet/package_policies`).

`readLive` calls the relevant tool; `project` maps the Kibana response onto the repo JSON shape.

- Pros: self-contained in this monorepo; mirrors the proven live-read+projection pattern; fully unit/integration-testable here; reused by any future agent feature.
- Cons: needs Kibana creds wired into the MCP server (the elastic-iac CI already holds `TF_VAR_local_api_key` per deployment — same key, needs surfacing to the server), and a reader per resource family. Must read the **same** Kibana state the Terraform provider refreshes, or reconcile and plan disagree.

## Approach B — terraform-plan `before` values

The drift-check already does the live read during `plan` (provider refresh); the full tfplan JSON carries `before` (live) and `after` (desired) per resource. Enrich the elastic-iac repo's `scripts/tf-report.jq` to emit `before` values into `drift-report.json` (additive field), extend `parseDriftReport` to keep them, and `readLive` reads from the report instead of an MCP tool.

- Pros: uniform across **all** stacks with no per-resource reader and no new creds; the live read is exactly what `plan` saw (no reconcile-vs-plan drift).
- Cons: edits the **elastic-iac repo CI** (a separate repo, not in this session's scope — needs a coordinated change there); `before` is in Terraform **provider-schema** terms and must be reverse-mapped to the repo's JSON-config shape (the module's `jsondecode` input), which is per-stack and not always 1:1; larger `drift-report.json` payloads.

## Comparison + recommendation

| | A: Kibana readers | B: tfplan before-values |
|---|---|---|
| Repos touched | this monorepo only | this monorepo + elastic-iac CI |
| New creds | Kibana API key surfaced to MCP server | none |
| Per-stack work | reader + projection | projection (reverse-map) |
| Uniformity | reader per family | one mechanism, all stacks |
| In this session's reach | yes | partial (CI change is external) |
| Risk | reconcile vs plan must read same state | provider-schema -> repo-JSON mapping |

Recommendation (author): **A**, because it is self-contained in this repo, matches the existing proven pattern, and is fully testable here without a coordinated change to a repo this session cannot access. B is attractive long-term for uniformity; the registry makes either `readLive` pluggable per family.

### Decision (2026-06-03)

Maintainer selected **Approach B** (tfplan `before` values). Implications:

- The live-state source is the enriched `drift-report.json`, not a Kibana reader. For new families, the registry's `readLive` reads `before` values from the report instead of calling an MCP tool.
- **Cross-repo dependency:** the elastic-iac repo's `scripts/tf-report.jq` (and the drift-report schema) must emit per-resource `before` values. That repo is outside this session's scope (GitHub MCP is scoped to `zx8086/devops-incident-analyzer`; elastic-iac is a separate GitLab project, id 71488350). It must change in a coordinated elastic-iac MR before the agent-side projection can be validated end-to-end. The jq snippet should be drafted here and handed off.
- This monorepo can still land the decision-independent pieces immediately: the registry refactor, the `kind` rename, and `parseDriftReport` accepting an optional `before`/`values` field (tolerant of today's reports that lack it).

## First increment: `dataviews` end-to-end

Smallest schema, and the operator had real `dataviews` drift (5 actionable). Steps:

1. Registry + `kind` rename refactor (no behavior change; deployment + ILM become registry entries; full existing test suite stays green).
2. Add `ELASTIC_IAC_CONFIG_DATAVIEW_STACKS` (default `dataviews`) + `ELASTIC_IAC_DATAVIEW_JSON_TEMPLATE` (default to be confirmed against the real repo layout, likely `environments/<cluster>/dataviews/<id>.json`).
3. Approach A: add `kibana_get_data_views` to the elastic MCP server (read-only, Kibana auth).
4. `project`: map a live data view onto the repo JSON shape.
5. Register the `dataviews` family; gate + labels pick it up automatically.
6. Tests: projection unit tests (live -> file, empty-diff, malformed), classify/gate tests, an MCP `tools/list` + live-call probe.

## Label / wording fix (ships with increment 1 regardless of A/B)

- `state.ts`: rename `kind: "hcl"` -> `"terraform-only"` (or `"unwired"`); update `classifyStackByName` and all consumers/tests.
- `reconcileGate`: when a stack has no live-reconcile family, the message states "Reconcile to Live is not wired for `<stack>` yet" rather than implying Terraform/HCL.
- Frontend (`agent-reducer.ts:RECONCILE_DIRECTION_LABELS`, `ReconcileChoiceCard`, `DriftReportCard`): no label change needed; only the absence reason flows through from the gate.

## Open questions / decisions needed

1. ~~Approach A or B?~~ RESOLVED: **B** (2026-06-03, maintainer).
2. Real repo path template for `dataviews` (and the per-resource file vs single-file layout) — confirm against the elastic-iac repo.
3. Kibana auth surfacing for the MCP server (Approach A) — reuse `TF_VAR_local_api_key` per deployment, or a dedicated read-scoped key?
4. Stack order after `dataviews` (candidates by operator value: `alerting`, `agent-policies`, `fleet-integrations`).

## Sequencing (Approach B)

1. (this monorepo, decision-independent, safe now) Registry refactor + `kind: "hcl"` -> `"terraform-only"` rename + gate absence-reason copy. No behavior change; full suite stays green.
2. (this monorepo) `parseDriftReport` keeps an optional per-resource `before`/`values` map (backward-compatible; absent in today's reports -> reconcile simply stays unavailable until the report carries them).
3. ~~(elastic-iac repo, EXTERNAL) emit per-resource `before` values into `drift-report.json`~~ **DONE** (elastic-iac `0f845a3`, via `scripts/drift-check.ts` + `scripts/drift-values.ts`). Work order: `docs/superpowers/specs/2026-06-03-elastic-iac-before-values-workorder.md`.
4. (this monorepo) `dataviews` family: reverse-map the `before` provider-schema values onto the repo JSON shape; register the family; tests.
5. (this monorepo) Frontend absence-reason copy.

Steps 1-2 proceed immediately; steps 3-4 are blocked on the elastic-iac schema defined in step 3.

## Test / verification plan

- `bun run typecheck && bun run lint && bun run test` after each step.
- New unit tests for the registry, the `dataviews` projection, and classify/gate changes.
- MCP validation: `tools/list` shows the new Kibana reader; a live call returns a 2xx body the projection accepts (per the project rule: validate MCP tool changes by running the tool, not just typechecking).
- Manual: trigger a `dataviews` drift on a sandbox deployment (e.g. `gl-testing`), confirm the gate offers Reconcile to Live, accept it, and confirm the opened MR's `plan:<dep>:dataviews` job shows no remaining drift.

## Update — 2026-06-03 (elastic-iac delivered)

The elastic-iac side shipped (commit `0f845a3` on `main`); see that team's operational handover. Adjustments to this plan:

- **Producer:** `values` is emitted by `scripts/drift-check.ts --format=json` with redaction in `scripts/drift-values.ts` (not a `tf-report.jq` change as the work order assumed). Contract otherwise as specified: `values[key] = {before, after}`, keys 1:1 with `changedKeys`, sentinels `"<redacted:sensitive>"`/`"<omitted:too-large>"`, present only on update/replace.
- **Marker path already aligned:** the agent's `reconcileMarkerPath` default (`stacks/${stack}/.agent-reconcile/${deployment}.json`) matches the CI carve-out — no change needed.
- **First reconcile-to-live target moves from `dataviews` to `agent-policies`.** Verified live: `dataviews/eu-b2b` drift is all *creates* (no `before` values -> not a reconcile-to-live target); `agent-policies/eu-b2b` has 16 *updates* with populated `values`. `dataviews` stays a candidate wherever it has update drift.
- **Direction is a runtime judgment (handover section 5).** Some update drift should reconcile to *declared*, not live (e.g. the observed `name` drift is a trailing space the repo trimmed -> reverting to declared is likely correct). The projection is identical; the to-live-vs-to-declared choice is the operator/agent's, enabled by surfacing both `before` and `after`.
- **DONE (this monorepo):** (1) `parseDriftReport` + `StackDriftResource`/`DriftResourceChange` carry the optional `values` field; (2) registry refactor + `kind: "hcl"` -> `"unwired"`; (3) report-sourced family + generic projection `applyReportValuesToConfig` (top-level keys; redaction-sentinel + per-key empty-diff guards) with `agent-policies` registered and `buildReportSourcedReconcile` wired into `buildLiveReconcile`. Tests in `drift.test.ts` (141 IaC tests pass).
- **Built against the README-implied convention** (`environments/<dep>/<stack>/<for_each-key>.json`, provider attr = top-level JSON key), env-overridable via `ELASTIC_IAC_CONFIG_REPORT_STACKS` + `ELASTIC_IAC_STACK_CONFIG_TEMPLATE`. **To finalize:** confirm the real `agent-policies` layout with the elastic-iac team (is the filename the `for_each` key? are attrs top-level or nested?) and adjust the template/projection if it differs. Reconcile *direction* (to-live vs to-declared) remains the operator's runtime call (handover section 5).
