# HANDOFF — SIO-920: dashboards (NDJSON saved-object) config-edit proposer

| | |
|---|---|
| **Date** | 2026-06-16 |
| **Ticket** | [SIO-920](https://linear.app/siobytes/issue/SIO-920) — Config-edit proposer: dashboards (NDJSON saved-object files) |
| **Parent epic** | [SIO-911](https://linear.app/siobytes/issue/SIO-911) — "Agent proposes, GitOps disposes — full elastic-iac repo parity" |
| **Status** | Todo (this is the **last remaining ticket** in the SIO-911 epic) |
| **Repo state** | branch `sio-919-deployments-topology-proposer` @ `b2fbdcb` (SIO-919, PR #213, In Review). Branch SIO-920 **off `main`** — do NOT stack on the 919 branch. |
| **Suggested branch** | `sio-920-dashboards-ndjson-proposer` |
| **Priority** | Low (P4) — dashboards are rarely hand-edited; NDJSON is the most awkward format to mutate. Do it LAST. |

---

## TL;DR

Add a `dashboard-edit` config-edit workflow to the elastic-iac agent so it can **propose** (never execute) whole-file add/replace/delete of a Kibana dashboard NDJSON in `environments/<deployment>/dashboards/<space>__<name>.ndjson`, opening a GitLab MR. **Scope is whole-file only** — the agent commits an exported NDJSON string verbatim; surgical in-place panel/visualization edits are explicitly OUT (follow-up if ever needed). Risk **MEDIUM** (dashboards are display-only; a malformed NDJSON fails CI's import job, not production). The `<space>__` filename prefix must match an existing space. Success = "add this dashboard to the developer-experience space on eu-b2b" (with an NDJSON payload) commits a new `developer-experience__<name>.ndjson` via `create`, with a multi-line-fixture test proving the proposer never `JSON.parse`s the whole file.

This is the 8th proposer built on the **exact same recipe** as SIO-914..919. The previous ticket (SIO-919, topology-edit) is a complete, verified reference — copy its structure.

---

## Context — how this ticket came to be

SIO-911 is the epic to make the elastic-iac agent able to propose *everything* the `observability-elastic-iac` repo can do (v7 deck slide 18: "Agent Proposes, GitOps disposes"). Each config stack got its own proposer ticket. Shipped so far on the same recipe: SIO-914 (fleet-integration), 915-918 (slo/alerting/dataview/cluster-default/space/security), **919 (deployment topology — autoscale/tier/SSO/sizing)**. SIO-920 (dashboards) is the final stack and the most awkward because dashboards are **NDJSON** (newline-delimited Kibana saved-object exports), not a single JSON object.

The recipe is documented in memory: `reference_config_edit_workflow_recipe` (proven by SIO-914) and `reference_iac_topology_edit_full_surface` (SIO-919). Read both before starting.

---

## Where the bodies are buried (verified ground truth)

### Real dashboard file layout (verified live from `pvhcorp/dhco/observability/observability-elastic-iac`, ref `main`)

Path: `environments/<deployment>/dashboards/<space>__<dashboard-slug>.ndjson` — **one NDJSON file per dashboard**. `eu-b2b` has 6 entries:

```
environments/eu-b2b/dashboards/
  default__pitch.ndjson                                                   (1.9 MB  — HUGE)
  default__status.ndjson                                                  (176 KB)
  default__summary.ndjson                                                 (17 KB)
  developer-experience__amazon_bedrock_token_usage.ndjson                 (8 KB)
  developer-experience__kong_api_gateway_platform_re_engineered.ndjson    (51 KB)
  terraform.tfvars                                                        (the stack's tfvars; NOT a dashboard)
```

Filename convention: `<space>__<name>.ndjson` (space, then **double underscore**, then slug). Space prefix MUST be an existing space (cross-check `environments/<dep>/spaces/`).

### NDJSON structure (THE critical detail — do NOT parse the whole file as one JSON)

Each line is a standalone JSON object. A file is **N saved-object lines + a trailing export-summary line**. Verified shapes:

- `developer-experience__amazon_bedrock_token_usage.ndjson` (2 lines):
  - line 1: `{type:"dashboard", id:"generative-ai-token-usage-bedrock-develo...", attributes:{title:"Amazon Bedrock Token Usage", ...}, references:[...], coreMigrationVersion, typeMigrationVersion, created_at, ...}`
  - line 2 (EXPORT SUMMARY): `{excludedObjects:[], excludedObjectsCount:0, exportedCount:1, missingRefCount:0, missingReferences:[]}`
- `default__status.ndjson` (also 2 lines, but the object is a `type:"canvas-workpad"` with `attributes:{name, pages, assets, css, ...}` then the export summary).

So: object lines carry `type` (`dashboard` | `lens` | `visualization` | `canvas-workpad` | `index-pattern` | `tag` | ...), `id`, `attributes` (with `title` OR `name`), `references[]`, and migration metadata. **The last line is the export summary, not a saved object.** A whole-file replace commits the user's exported NDJSON verbatim and never has to understand any of this — which is exactly why the ticket scopes to whole-file only.

> WARNING: some files are large (pitch = 1.9 MB). Never `Read` a whole dashboard NDJSON into context to "inspect" it — you'll blow the window. For the proposer you only ever pass the raw string through; for tests use a small hand-authored 2-3 line fixture.

### The stack's `terraform.tfvars` (how dashboards get imported by CI)

```
deployment_name = "eu-b2b"
config_path     = "../../environments/eu-b2b/dashboards"
kibana_endpoints        = ["https://<id>.eu-central-1.aws.cloud.es.io:443"]
ssm_api_key_path        = "/elastic/observability/eu_b2b/es_api_key"
```

CI's dashboards module imports every `*.ndjson` under `config_path` into Kibana via the saved-objects import API. A malformed NDJSON fails that import job (MEDIUM, not production-breaking). **The agent only writes the file + opens the MR; it does NOT trigger the import** (GitOps disposes).

### No dashboards code exists yet (confirmed)

`grep -rn dashboard packages/agent/src/iac/` returns only incidental mentions in risk strings (integration bumps "can break dashboards", space edits "don't touch dashboards") and one stale capability line. There is no `dashboard-edit` workflow, no proposer, no skill.

---

## The fix (step-by-step) — mirror SIO-919 exactly

All edits are in `packages/agent/src/iac/`. Anchor line numbers are as of `b2fbdcb` (will drift as you edit — re-grep).

### 1. `state.ts` — workflow enum + fields (the `IacRequest` interface, `workflow:` union at line 6)

Add `"dashboard-edit"` to the workflow union. Add fields:
```ts
// SIO-920: dashboard-edit -- whole-file add/replace/delete of a Kibana NDJSON saved-object export.
// MEDIUM risk (display-only; malformed NDJSON fails CI import, not prod). Whole-file only -- no panel edits.
dashboardSpace?: string;      // the <space> prefix; must match an existing space
dashboardName?: string;       // the <name> slug (filename = <space>__<name>.ndjson)
dashboardNdjson?: string;     // the raw exported NDJSON payload (committed verbatim)
dashboardAction?: "add" | "replace" | "delete";
```
No new `IacState` flag needed (dashboards are a fixed MEDIUM, like space-edit; topology used no flag either).

### 2. `nodes.ts` — `IntentSchema` (line 65) + `parseIntent` (`nn()` block ~line 180)

In `IntentSchema = z.object({...})` add:
```ts
dashboardSpace: z.string().nullish(),
dashboardName: z.string().nullish(),
dashboardNdjson: z.string().nullish(),
dashboardAction: z.enum(["add", "replace", "delete"]).nullish(),
```
In `parseIntent`'s returned object add the `nn(p.x)` mappings for all four. (`nn = v ?? undefined`.) Add the field names to the **keys-list** prose string (the one enumerating all extractable fields, ~line 328 `"...tierAutoscale, userSettingsTarget, ... reason, isProd..."`) and add a **dashboard guidance paragraph** to the big parseIntent system prompt (mirror the topology paragraph at ~line 390): explain `dashboard-edit`, that the NDJSON is taken verbatim, `add`/`replace`/`delete`, the `<space>__<name>` filename, and "whole-file only, no panel edits".

### 3. `nodes.ts` — `capabilityMessage()` (line 215)

- Add a bullet (mirror the topology bullet at ~line 231): `'- **Dashboards** -- add/replace/delete a Kibana dashboard NDJSON in a space; e.g. "add this dashboard to the developer-experience space on eu-b2b" (MEDIUM risk; whole-file only)\n\n'`.
- Line ~234 currently lists `dashboards` in the "More config stacks (... dashboards, ...) coming" sentence — **remove `dashboards` from that not-yet-supported list** since it now IS supported.

### 4. `nodes.ts` — path template helper (near `deploymentJsonTemplate` line 886 / `ilmPolicyTemplate` line 893)

Add a `dashboardNdjsonTemplate()` following the SAME lazy-`process.env` shape (no module-scope `Bun.env` — Vite SSR throws):
```ts
function dashboardNdjsonTemplate(): string {
  return process.env.ELASTIC_IAC_DASHBOARD_TEMPLATE ?? "environments/${cluster}/dashboards/${space}__${name}.ndjson";
}
```
`${cluster}`, `${space}`, `${name}` are literal placeholders substituted by your path resolver. NOTE: biome flags `noTemplateCurlyInString` on these as a **warning** (the existing 3 templates have the same warning — it is pre-existing and accepted, NOT an error). You will need a small path-build helper (look at how `deploymentJsonPath` / `ilmPolicyPath` substitute placeholders and reuse that pattern).

### 5. `nodes.ts` — `proposeDashboardChange(state, req)` proposer (add before `draftChange` at line 2529; mirror `proposeTopologyChange`)

Logic (propose-only, MEDIUM):
1. Validate inputs: need `dashboardSpace`, `dashboardName`, an `action`. For `add`/`replace`, need a non-empty `dashboardNdjson`. Missing/empty → `blockedReason` + clarifying `AIMessage` (NOT a broken commit). **This is acceptance criterion 3.**
2. Build `filePath` from the template (`<dep>/dashboards/<space>__<name>.ndjson`).
3. **Cross-check the space exists**: read `environments/<dep>/spaces/<space>.json` (or list the dashboards dir / spaces dir) via `gitlab_get_file_content` / `gitlab_get_repository_tree`. If the space doesn't exist → block with a clarifying message ("`<space>` is not a space on `<dep>`"). (Acceptance: the `<space>__` prefix must match an existing space.)
4. **Do NOT `JSON.parse` the whole payload.** Treat `dashboardNdjson` as an opaque raw string. The only validation worth doing is cheap and line-aware: split on `\n`, drop blank lines, and check each non-blank line is parseable JSON (a per-line `JSON.parse` in a try/catch) so a obviously-malformed payload is caught — but you commit the ORIGINAL string verbatim, not a re-serialized one. **Acceptance criterion 2 wants a test proving no whole-file parse** — so keep the "parse per line for validation only, commit raw" split explicit and testable.
5. For `add`: 404 on the file is expected/fine (you're creating it); use `action: "create"` on `gitlab_commit_file`. For `replace`: file should exist (404 → block "no such dashboard to replace"); `action: "update"`. For `delete`: there is no delete-file in the current MCP toolset — check `gitlab_commit_file` for a `delete` action; if unavailable, scope delete as a follow-up and `blockedReason` it (mirror how other proposers handle unsupported ops). **Confirm what `gitlab_commit_file` supports before committing to a delete path.**
6. Branch via `branchName(req)`, commit, set `precheckPassed` from the commit result (the `!commit.startsWith("[4"/"[5")` idiom).
7. Build a `proposedDiff` that is a SUMMARY, not the NDJSON body (the file can be 1.9 MB — never dump it). E.g. `"developer-experience__amazon_bedrock_token_usage.ndjson (add): 1 saved object + export summary, <N> bytes"`. Derive the object count by counting non-summary lines.
8. Return `{ branch, proposedFilePath, proposedDiff, precheckPassed }`.

Add the dispatch line in `draftChange` (after line 2542):
```ts
if (req.workflow === "dashboard-edit") return proposeDashboardChange(state, req);
```

### 6. `nodes.ts` — `reviewPlan` (line 2556) risk + title + MR context + categoryRisk

- Add a `dashboard-edit` risk block (mirror the space-edit MEDIUM block, NOT the topology HIGH one). Risk MEDIUM: "Dashboard NDJSON change (display-only); a malformed export fails CI's saved-objects import job, not production. Whole-file replace — panel-level changes are not reviewed here."
- Extend the **title descriptor ternary** (~line 2700, the long chain ending `: (req?.tier ?? req?.resource ?? "change")`) with a `dashboard-edit` branch: `\`${req?.dashboardSpace ?? "?"}/${req?.dashboardName ?? "?"}: ${req?.dashboardAction ?? "change"}\``.
- Extend **buildMrDescription context** (~line 2807, the topology context block) with a dashboard line.
- Extend **categoryRisk** (~line 2688 the topology `"Category deployment-topology, Risk HIGH"` ternary) with `"Category dashboard, Risk MEDIUM"`.
- Extend **branchSlug** (line 843, the descriptor ternary) with a `dashboard-edit` branch using `req.dashboardName` as the descriptor.

> GOTCHA you WILL hit: the `Edit` tool repeatedly fails to match the long template-literal lines and nested ternaries in `reviewPlan`/`branchSlug` (tab-vs-space matching). SIO-916..919 all resorted to **Python line-splice scripts** matching on a unique substring. Do that from the start for the ternary/context edits — see "Verification" for the exact pattern.

### 7. `agents/elastic-iac/skills/edit-dashboard/SKILL.md` (new) + register + canary

- Create `agents/elastic-iac/skills/edit-dashboard/SKILL.md`. Mirror `grant-security-role/SKILL.md` / `edit-deployment-topology/SKILL.md` structure: frontmatter (`name`, `description`, `inputs`), the file path + NDJSON shape, the change (read-modify-write / add), Risk MEDIUM, Anti-patterns (refuse surgical panel edits, refuse a non-existent space prefix, never dump the NDJSON in the diff), MR body (Category `dashboard`, Risk MEDIUM).
- Register in `agents/elastic-iac/agent.yaml` skills list (insert `- id: edit-dashboard` after `- id: edit-deployment-topology`, before `- id: pre-check-gl-testing`).
- **Bump the canary**: `packages/gitagent-bridge/src/elastic-iac-load.test.ts` has a `toEqual([...])` skill-list assertion (currently 13 entries incl. `edit-deployment-topology` at line 27). Add `"edit-dashboard"` in the same position. This test BREAKS THE BUILD if you forget — that's intentional.

### 8. `packages/agent/src/iac/dashboard-edit.test.ts` (new) — mirror `deployment-topology.test.ts`

Use `mockTools` (copy the exact helper from `space-security.test.ts:186` / `deployment-topology.test.ts` — it mocks `../mcp-bridge.ts` exporting `getToolsForDataSource` + `getConnectedServers`, with tool objects `{name, invoke}`). Tests:
- **Raw-NDJSON, no whole-file parse** (acceptance 2): a 3-line multi-object fixture (2 saved objects + export summary) committed verbatim — assert `committed.content` equals the input string byte-for-byte (this proves no re-serialization / no `JSON.parse`).
- **add happy path** (acceptance 1): "add to developer-experience" → `proposedFilePath === "environments/eu-b2b/dashboards/developer-experience__<name>.ndjson"`, `precheckPassed === true`, `gitlab_commit_file` called with `action: "create"`.
- **malformed/empty payload blocks** (acceptance 3): empty `dashboardNdjson` → `blockedReason`, no commit.
- **unknown space blocks**: `dashboardSpace` not in the spaces stack → `blockedReason` contains the space name.
- **diff is a summary, not the body**: assert the proposedDiff does NOT contain a long chunk of the fixture (e.g. an inner panel id), only the filename + count.
- `parseIntentJson` mapping test + `branchSlug` test + `reviewPlan` MEDIUM-category test (mirror the topology ones).

---

## Files to modify (table)

| File | Change |
|---|---|
| `packages/agent/src/iac/state.ts` | `dashboard-edit` enum + `dashboardSpace`/`dashboardName`/`dashboardNdjson`/`dashboardAction` |
| `packages/agent/src/iac/nodes.ts` | IntentSchema + parseIntent + keys-list/guidance + `capabilityMessage` (add bullet, remove `dashboards` from the not-yet list) + `dashboardNdjsonTemplate` + path helper + `proposeDashboardChange` + `draftChange` dispatch + `reviewPlan` MEDIUM risk/title/context/categoryRisk + `branchSlug` |
| `agents/elastic-iac/skills/edit-dashboard/SKILL.md` | new skill |
| `agents/elastic-iac/agent.yaml` | register `- id: edit-dashboard` |
| `packages/gitagent-bridge/src/elastic-iac-load.test.ts` | canary: add `"edit-dashboard"` to the `toEqual` skills array (13 -> 14) |
| `packages/agent/src/iac/dashboard-edit.test.ts` | new test file |

---

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer   # or your worktree
# typecheck (agent + bridge)
bun run --filter '@devops-agent/agent' --filter '@devops-agent/gitagent-bridge' typecheck
# new test
bun test packages/agent/src/iac/dashboard-edit.test.ts
# canary + capability + full iac regression (expect 385 + your new tests, 0 fail)
bun test packages/gitagent-bridge/src/elastic-iac-load.test.ts
bun test packages/agent/src/iac/capability-message.test.ts
bun test packages/agent/src/iac/
# lint (expect 0 NEW errors; the lone repo "error" is a pre-existing broken guides/ symlink,
# and ${cluster}/${space}/${name} path-placeholder warnings are pre-existing/accepted)
bun run lint
bun run yaml:check
```

**Python line-splice pattern** for the ternary/context edits the `Edit` tool can't match (used in every prior ticket):
```bash
python3 - <<'PY'
path = "packages/agent/src/iac/nodes.ts"
s = open(path, encoding="utf-8").read()
needle = '].filter(Boolean).join(", ") || "topology"}`'   # or a unique anchor near your target
assert needle in s
s = s.replace(needle, '<your new segment>' + needle, 1)
open(path, "w", encoding="utf-8").write(s)
PY
```
Then `bun run lint:fix` to normalize ternary indentation, and `bun run --filter '@devops-agent/agent' typecheck` to prove the splice is valid.

**Live verification (optional, per ticket):** add a trivial dashboard NDJSON to a sandbox space on `gl-testing` (NOT a prod deployment), POST to the agent stream, and confirm CI's import job validates it. The agent stream recipe is in memory `reference_agent_stream_curl_endpoint` and `reference_iac_ilm_e2e_validated` (POST /api/agent/stream, `agentName: "elastic-iac"`, then resume the HITL decision `approved`). NOTE: a COLD web-server restart is required to pick up `agents/elastic-iac/` skill/agent.yaml changes — `getAgentByName` memoizes (memory `reference_agent_knowledge_cached_per_process`); `--hot` is not enough.

---

## Workflow

1. `git checkout main && git pull && git checkout -b sio-920-dashboards-ndjson-proposer` (branch off **main**, not the 919 branch).
2. Implement per the steps above. Run typecheck/lint/test after each meaningful change.
3. Linear: set SIO-920 `In Progress` when you start.
4. Commit (no commit without the user's go-ahead; this handoff/session IS authorization to implement, but confirm before the FINAL commit if unsure). HEREDOC message template:
   ```bash
   git commit -F - <<'EOF'
   SIO-920: dashboards NDJSON config-edit proposer (whole-file add/replace/delete)

   <body: surfaces, whole-file-only scope, MEDIUM risk, space-prefix cross-check,
   no-whole-file-parse guarantee, recipe touch-points, verification results>

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   ```
5. Push, open PR **ready-for-review (NEVER draft)** against `main`. PR body: surfaces, scope, risk, touch-points table, test list, verification block.
6. Set SIO-920 `In Review` (NEVER `Done` without explicit user approval). The GitHub PR auto-links to the ticket.
7. This closes the SIO-911 epic — note that in the PR / a ticket comment.

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Naively `JSON.parse` the whole NDJSON → crash on multi-line files | HIGH if you forget | Parse per-line for validation only; commit the raw string. Acceptance criterion 2 + a test enforce this. |
| Reading a 1.9 MB dashboard into context to "inspect" → blows the window | MEDIUM | Never `Read` real dashboard files; use a 2-3 line hand-authored fixture. The proposer passes the string through opaquely. |
| `Edit` tool fails on `reviewPlan`/`branchSlug` long ternaries | HIGH (hit every prior ticket) | Use Python line-splice from the start (pattern above). |
| Forget the gitagent-bridge canary bump | MEDIUM | The canary test fails the build — it's the safety net. Bump it in the same commit. |
| `gitlab_commit_file` may not support a `delete` action | MEDIUM | Confirm the toolset before wiring delete; if unsupported, scope delete to a follow-up and `blockedReason` it (mirror prior "unsupported op" handling). |
| Dump the NDJSON body in the diff/MR (huge, noisy) | MEDIUM | proposedDiff is a summary (filename + action + object count + byte size), never the body. Add a test asserting an inner id is absent from the diff. |
| Stale dev server serves pre-merge code during live check | MEDIUM | Cold-restart `bun run dev` after `git pull`; `--hot` doesn't re-resolve (`reference_bun_hot_does_not_reresolve_modules`, `reference_agent_knowledge_cached_per_process`). |

---

## Out of scope (this ticket)

- **Surgical panel / visualization edits** inside an existing NDJSON saved object (free-form mutation of a dashboard's panels). Explicitly a follow-up if ever needed — note it in the SKILL anti-patterns and the PR.
- Editing the dashboards `terraform.tfvars` (endpoints / api-key path) — that's deployment plumbing, not a dashboard content change.
- Triggering the CI import — GitOps disposes; the agent only writes the file + MR.

---

## Related code references (reference patterns — already correct)

- `packages/agent/src/iac/nodes.ts:2272`-ish `proposeTopologyChange` (SIO-919) — the closest sibling; multi-surface, with the empty-diff guard, 404 handling, summary diff. **Copy its skeleton.**
- `proposeSpaceChange` / `proposeSecurityRoleChange` (in `nodes.ts`; tested in `space-security.test.ts`) — MEDIUM/space-prefix patterns and the `mockTools` test idiom.
- `agents/elastic-iac/skills/edit-deployment-topology/SKILL.md` and `grant-security-role/SKILL.md` — SKILL structure to mirror.
- `packages/agent/src/iac/deployment-topology.test.ts` — test structure (pure helpers + draftChange-with-mock + reviewPlan + branchSlug + parseIntentJson); `mockTools` helper lives at its bottom.
- `branchSlug` (nodes.ts:843), `draftChange` (2529), `reviewPlan` (2556), `IntentSchema` (65), `capabilityMessage` (215), `deploymentJsonTemplate`/`ilmPolicyTemplate` (886/893) — the exact anchors to extend.

---

## Memory references

- `reference_config_edit_workflow_recipe` — the canonical SIO-915..920 recipe (touch-points, the canary, the TS-strict Record cast gotcha, per-stack JSON shapes).
- `reference_iac_topology_edit_full_surface` — SIO-919, the immediately-preceding sibling (verbatim-content + value-withheld diff patterns, the FLAT path note).
- `project_elastic_iac_agent_proposes_gitops_disposes` — the epic's propose-only contract; real repo checkout at `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/`.
- `reference_elastic_iac_migrated_to_gitlab_com` — GitOps target is `pvhcorp/dhco/observability/observability-elastic-iac` on gitlab.com (id 82850717); needs `ELASTIC_IAC_GITLAB_BASE_URL` + cold MCP restart.
- `reference_agent_knowledge_cached_per_process` — COLD restart required after `agents/elastic-iac/` edits.
- `reference_agent_stream_curl_endpoint` + `reference_iac_ilm_e2e_validated` — live e2e recipe (POST /api/agent/stream, resume decision `approved`).
- `feedback_no_direct_push_to_main` / `feedback_handoff_docs_main_branch` — code goes via branch+PR; this handoff doc commits to main directly.
