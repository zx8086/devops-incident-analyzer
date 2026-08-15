# Renovate integration-update intent for the elastic-iac graph

Date: 2026-08-15
Origin: follow-up to [SIO-1470](https://linear.app/siobytes/issue/SIO-1470/add-renovate-on-demand-mr-trigger-tools-to-mcp-server-elastic-iac) (merged PR [#662](https://github.com/zx8086/devops-incident-analyzer/pull/662)), which added two GitLab MCP tools (`gitlab_unschedule_renovate_branches`, `gitlab_play_pipeline_schedule`) to `packages/mcp-server-elastic-iac` but wired them into nothing. This spec is the orchestration layer that makes the outcome real: a user says "update prometheus on eu-b2b" and the agent triggers the on-demand Renovate run and reports back the resulting MR.

## Problem

SIO-1470 built the *mechanism* — the two GitLab REST calls a human today performs by hand (tick a Dependency Dashboard checkbox, play the Renovate pipeline schedule). Nothing in the LangGraph pipeline calls them. A request like "update prometheus on eu-b2b" today has no correct classification: `fleet-upgrade` is Fleet agent *binaries*, a different axis entirely (`nodes.ts:806-809`'s explicit "NOT fleet-upgrade" carve-out for deployment/cluster version), and while `gitops`'s `fleet-integration` workflow (`proposeFleetIntegration`, `nodes.ts:4037-4150`) sounds adjacent, it is out of scope here — see "Relationship to the existing `fleet-integration` gitops workflow" below.

## Relationship to the existing `fleet-integration` gitops workflow

`packages/agent/src/iac/nodes.ts` already has a `gitops` sub-workflow named `fleet-integration` (classifier text at `nodes.ts:1045-1050`, implementation `proposeFleetIntegration` at `nodes.ts:4037-4150`) that hand-authors a version pin for an integration package by editing `environments/<dep>/fleet-integrations/integrations.json` directly and opening an MR via `gitlab_commit_file`/`gitlab_create_merge_request`.

Verified live against the real target repo (`pvhcorp/dhco/observability/observability-elastic-iac`, project 82850717) that this is **not** an equivalent alternative to what this spec builds:

- `renovate.json`'s `fleet-integrations` custom regex manager owns BOTH surfaces per package: `environments/<dep>/fleet-integrations/integrations.json` (install pin) AND `environments/<dep>/agent-policies/*.json` (policy pin), grouped by `depName` so Renovate opens **one MR moving both pins atomically**.
- `docs/operational/renovate-fleet-packages-runbook.md` (live-read) documents this atomicity as the reason the install-before-policy `ORDER GUARD`/`ORDER VIOLATION` checks in `stacks/agent-policies/main.tf` and `modules/agent-policy/main.tf` never fire in the normal flow — both pins always move together.
- `proposeFleetIntegration` only writes the install-pin file. It does not touch the agent-policies pin, which the runbook documents as exactly the lagging-pin scenario the `ORDER GUARD` warns about.

This is a pre-existing gap in `proposeFleetIntegration`, not something this spec is chartered to fix. **Decision: leave the existing `fleet-integration` gitops workflow untouched** — no code change, no deletion. The new intent this spec adds becomes the effective default path for "update an integration package" requests because its classifier bucket is worded to claim that phrasing (see §1) — Renovate is the complete, atomic, already-proven mechanism (its own dashboard only ever proposes the registry-latest version, confirmed live: every checkbox line on the real Dependency Dashboard reads `chore(deps): [<dep>] <package> to v<latest>`, there is no explicit-older-version variant to request). `fleet-integration`'s existing prompt text is left as-is and becomes reachable in practice only for phrasing this spec's new bucket doesn't claim.

## Scope

In scope: one new intent, its 5-node sub-flow, one new pure helper + one new MCP tool in `mcp-server-elastic-iac` (see §3a — `gitlab_list_merge_requests_by_source_branch` did not already exist, verified), and the minimal cross-datasource tool-lookup addition needed to discover the Dependency Dashboard issue by title via the existing native GitLab MCP proxy (no new tool needed for that part).

Out of scope: merge/apply automation, selection-policy beyond "one deployment + one integration per request" (the real dashboard's `<!-- create-all-awaiting-schedule-prs -->` bulk-trigger marker, confirmed live, is a possible future extension, not built here), a dedicated service-account token (reuses `ELASTIC_IAC_GITLAB_TOKEN`, same as every other `mcp-server-elastic-iac` tool today), any change to `DATASOURCE_TO_MCP_SERVER`'s 1:1 mapping, and any change to the existing `fleet-integration` gitops workflow (see above).

## Design

### 1. New intent: `renovate-integration-update`

Added to `INTENT_VALUES`/`IacIntent` (`packages/agent/src/iac/state.ts:44-53`):

```ts
export const INTENT_VALUES = [
	"info",
	"gitops",
	"gitops-amend",
	"pipeline-status",
	"drift",
	"synthetics-drift",
	"fleet-upgrade",
	"renovate-integration-update", // new
	"converse",
] as const;
```

`classifyIacIntent`'s LLM prompt (`nodes.ts:798-829`) gets one new bucket, inserted after the existing `fleet-upgrade` line (whose own text already explicitly disambiguates itself from cluster-version `gitops` — the new bucket needs the same explicit disambiguation against both neighbors, plus a third disambiguation against `gitops`'s own `fleet-integration` sub-workflow, which the new bucket's phrasing supersedes for this class of request per the "Relationship" section above):

> `'renovate-integration-update'`: a request to update a Fleet INTEGRATION PACKAGE (e.g. prometheus, cisco_ftd, system, a specific Elastic Agent integration) to its latest available version on a deployment — "update prometheus on eu-b2b", "bump the cisco_ftd integration for ap-cld", "get the latest system integration on us-cld", "update the fleet-server integration". This is the default classification for ANY integration-package update request, whether or not the user names a target version — Fleet integrations only ever install the latest registry version, so naming an explicit version does not change the classification. This is NOT a deployment/cluster version change (that's 'gitops') and NOT a Fleet AGENT BINARY upgrade (that's 'fleet-upgrade'). The tell: the thing being updated is a named *integration/package* the deployment ingests data through, not the cluster itself or the enrolled agents.

No new deterministic pre-LLM guard is needed — unlike the `gitops-amend`/`pipeline-status` guards (which exist because they must override *conversational* ambiguity on a follow-up turn), this intent is a same-shape first-turn classification the LLM prompt already handles adequately, matching how `fleet-upgrade`/`drift`/`synthetics-drift` also rely on the prompt alone.

### 2. Sub-flow: 5 nodes, mirroring `detectFleetUpgrade`'s detect → gate → apply → teardown shape

```
classifyIacIntent --(intent=renovate-integration-update)--> extractRenovateTarget
  --> resolveRenovateMarker --(exactly 1 match)--> renovateTriggerGate --(approved)--> triggerRenovateUpdate --> watchRenovateMr --> teardown
                             --(0 or 2+ matches)--> teardown (disambiguation message, no gate)
  renovateTriggerGate --(declined)--> teardown
```

This is the same shape as `detectFleetUpgrade`/`fleetUpgradeGate`/`applyFleetUpgrade` → `teardown` (`graph.ts:159-165,296-309`), extended by one extra detect-stage node because target *resolution* (matching free text to a live marker) is a separate concern from target *extraction* (parsing the user's words) — collapsing them into one node would make the 0/2+-match early-exit harder to express as a clean conditional edge.

**`extractRenovateTarget`** — a structured-output LLM call, matching the `parseIntent`/`IntentSchema` pattern (`nodes.ts:183-198,960-...`, JSON-instruction prompt + `zod.safeParse`) rather than `classifyIacIntent`'s bare one-word call, since this extracts two named fields, not a single enum:

```ts
const RenovateTargetSchema = z.object({
	deployment: z.string().nullish(),
	integration: z.string().nullish(),
});
```

Prompt instructs the LLM to extract `deployment` and `integration` as a strict JSON object with those two keys from the request, mirroring `parseIntent`'s "Extract ... as a single strict JSON object with keys: ..." instruction shape (`nodes.ts:962-963`). On extraction failure (either field empty/null after `safeParse`), routes straight to `teardown` with a clarifying message — no separate node needed for this, handled inline like `watchPipeline`'s early-return pattern (`nodes.ts:7801-7805`).

**`resolveRenovateMarker`** — three steps:
1. Discover the Dependency Dashboard issue by title search — see §3 for the new tool this requires.
2. Fetch its description, parse into `{ marker, line }` pairs with a new pure helper `parseDashboardEntries` (below).
3. Deterministically filter entries whose `marker` contains both `deployment` and `integration` as case-insensitive substrings (mirrors `findPipelineScheduleId`'s existing case-insensitive `.includes()` matching, `gitlab.ts:211-221` post-fix version). Exactly one match → proceed to the gate. Zero or 2+ matches → `teardown` with the candidate list (or "no pending update found") so the user can rephrase, never a guess.

**`renovateTriggerGate`** — an `interrupt()`-based gate, matching `fleetUpgradeGate`'s role (`graph.ts:305`: `s.fleetUpgradeApproved ? "applyFleetUpgrade" : "teardown"`). Shows the exact matched dashboard line before acting ("This will tick `renovate/eu-b2b-prometheus`: chore(deps): [eu-b2b] prometheus to v1.24.4, and trigger an off-schedule Renovate run. Proceed?").

**`triggerRenovateUpdate`** — calls the two SIO-1470 tools in sequence via the existing `callTool` helper (`nodes.ts:164-173`, already in scope for `AGENT = "elastic-iac"` since both tools live in `mcp-server-elastic-iac`):
```ts
await callTool("gitlab_unschedule_renovate_branches", { issueIid, markers: [marker] });
await callTool("gitlab_play_pipeline_schedule", { descriptionContains: "Renovate" });
```
Emits `iac_pipeline_progress` before/after, matching `detectFleetUpgrade`'s exact payload shape (`{ pipelineId: null, status: string }` before triggering, `nodes.ts:11475-11478`):
```ts
await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: triggered" });
```

**`watchRenovateMr`** — reuses `watchPipeline`'s exact bounded poll-loop shape (`nodes.ts:7838-7861`): same `IAC_PIPELINE_POLL_INTERVAL_MS`/`IAC_PIPELINE_POLL_BUDGET_MS` env vars (10s/90s defaults via `readPositiveMsEnv`), same `while (Date.now() < deadline)` structure, same `dispatchCustomEvent("iac_pipeline_progress", ...)` mid-loop emission. It polls for MR *existence* by `source_branch=renovate/<marker>` rather than polling an existing pipeline to a terminal status — see §3a for the new tool this requires (`gitlab_list_agent_merge_requests`, the only existing MR-listing tool, is filtered to `labels=agent-generated`, `gitlab.ts:1616-1633`, which a bot-authored Renovate MR never carries — verified by reading the tool, not assumed). On timeout, returns the same "still running, ask again" UX as `watchPipeline`'s own budget-exceeded path — no new mechanism, no new user-facing behavior class.

**`teardown`** — the existing shared terminal node (`graph.ts:310`), unchanged.

### 3. Issue discovery: reuse the native GitLab MCP proxy, no new tool

`resolveRenovateMarker` needs to discover the Dependency Dashboard issue by title, matching the original Renovate handover's own explicit warning against hardcoding the issue IID (it has already changed once, #9 → #11, when the title changed). The native GitLab MCP's `get_issue` tool is unreachable from the elastic-iac graph today — it belongs to a different, separately-routed data source (`"gitlab"` → `gitlab-mcp`, consumed today only by the main incident-analyzer graph's gitlab-agent sub-agent; confirmed via `DATASOURCE_TO_MCP_SERVER`, `mcp-bridge.ts:434-445`).

**Decision: wire cross-datasource access, following the exact precedent `infoTools()` already establishes** (`nodes.ts:1311-1315`):

```ts
export function infoTools(): StructuredToolInterface[] {
	const allowed = new Set<string>(INFO_TOOL_NAMES);
	const elasticReads = getToolsForDataSource(AGENT).filter((t) => allowed.has(t.name));
	const kgTools = getToolsForDataSource("knowledge-graph"); // <- already crosses into a DIFFERENT dataSourceId
	return [...elasticReads, ...kgTools, createSearchMemoryTool(AGENT), createLookupExamplesTool(AGENT)];
}
```

elastic-iac already calls `getToolsForDataSource("knowledge-graph")` — a different id than its own `AGENT` constant — without touching `DATASOURCE_TO_MCP_SERVER`. This is proven low-risk (confirmed via research): the map stays untouched (preserving `wiring-aws.test.ts`/`wiring-atlassian.test.ts` canaries and `sub-agent.ts`'s per-datasource tool-budget invariant, which elastic-iac never participates in — it does its own explicit named-tool lookups, not the main graph's `MAX_TOOLS_PER_AGENT` slicing); `gitlab-mcp` and `elastic-iac-mcp` are already two independently-connected servers in `apps/web`'s runtime (`agent.ts:222,225`), so no new connection or OAuth session is created; and the OAuth keep-alive/refresh-race handling (SIO-747) lives entirely inside the `mcp-server-gitlab` process, indifferent to how many client-side lookups resolve to it.

Extend `findTool` (`nodes.ts:158-160`) with a small named fallback rather than broadening the whole `AGENT` lookup:
```ts
function findGitlabProxyTool(name: string): StructuredToolInterface | undefined {
	return getToolsForDataSource("gitlab").find((t) => t.name === name);
}
```
`resolveRenovateMarker` calls `findGitlabProxyTool("gitlab_get_issue").invoke(...)` directly (or a small `callGitlabProxyTool` wrapper mirroring `callTool`'s degrade-on-missing behavior, `nodes.ts:164-173`) — but only for *discovering the issue by title*. Once the IID is known, the two-tool trigger sequence (§2's `triggerRenovateUpdate`) stays entirely within `mcp-server-elastic-iac`'s own tools, unchanged from SIO-1470.

**Why not add `gitlab_find_issue_by_title` as a new tool in `mcp-server-elastic-iac` instead** (the alternative considered): the native `gitlab-mcp` proxy already exposes `search`/`get_issue` capability live (confirmed in the SIO-1470 session's live tool-list check) — building a duplicate title-search tool in `mcp-server-elastic-iac` using its own `glJson` helper would re-solve a problem the proxy already solves, just with PAT auth instead of OAuth. Given the cross-datasource read is confirmed safe and connection-free, reuse wins over duplication here — unlike SIO-1470's issue *write* (`gitlab_unschedule_renovate_branches`), which had no native-proxy analog at all and genuinely needed new code.

### 3a. New tool: `gitlab_list_merge_requests_by_source_branch`

Verified live (read `gitlab.ts:1604-1633` in full): the only existing MR-listing tool is `gitlab_list_agent_merge_requests`, which is hardcoded to `labels=agent-generated&state=opened` — a label this repo's own `gitlab_create_merge_request` tool applies to agent-authored MRs (`gitlab.ts:423`, defaulting `labels` to `["agent-generated", "iac"]`), but Renovate is a separate bot that never applies it. `watchRenovateMr` needs its own tool.

New tool in `packages/mcp-server-elastic-iac/src/tools/gitlab.ts`, inserted next to `gitlab_list_agent_merge_requests`, following the identical pattern:

```ts
server.registerTool(
	"gitlab_list_merge_requests_by_source_branch",
	{
		description:
			"List merge requests by exact source branch name, any state, newest first. Used to detect a " +
			"Renovate-created MR after gitlab_play_pipeline_schedule triggers a run (Renovate MRs are not " +
			"labeled agent-generated, so gitlab_list_agent_merge_requests cannot find them). Read-only.",
		inputSchema: { sourceBranch: z.string().describe("Exact source branch name, e.g. 'renovate/eu-b2b-prometheus'.") },
		annotations: iacToolAnnotations("gitlab_list_merge_requests_by_source_branch"),
	},
	async ({ sourceBranch }) =>
		text(
			await gitlabFetch(
				gitlabBaseUrl,
				token,
				`/projects/${project}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&order_by=created_at&sort=desc&per_page=5`,
			),
		),
);
```

Classified `READ_ONLY_TOOLS` in `tool-classification.ts` (a GET, matching the read-only classification of `gitlab_list_agent_merge_requests` and `gitlab_get_merge_request` — listing MRs never mutates).

### 4. New pure helper: `parseDashboardEntries`

Colocated in `mcp-server-elastic-iac/src/tools/gitlab.ts` next to `tickDashboardCheckboxes` (`gitlab.ts:81-98`), TDD'd the same way:

```ts
// Parses the Dependency Dashboard issue body into {marker, line} pairs for one "- [ ]"
// checkbox line each, keyed by its unschedule-branch=<marker> HTML comment. Used to
// resolve a free-text deployment+integration name to the live marker string before
// calling gitlab_unschedule_renovate_branches -- never construct/guess a marker, always
// match against what the board actually contains this run. (Pure; unit-tested.)
export function parseDashboardEntries(description: string): Array<{ marker: string; line: string }>
```

Reuses the same marker-extraction regex `tickDashboardCheckboxes` already has (`gitlab.ts:92`: `/^(\s*-\s*\[) \](\s*<!--\s*unschedule-branch=(.*?)\s*-->)/`) — factor the regex into a shared constant both functions reference, rather than duplicating it.

This helper is **not** exposed as a new MCP tool — it's consumed directly by the graph node after that node calls the native `get_issue` proxy tool for the raw description (§3). Keeping it a plain exported TS function (not a tool) is consistent with how `resolveRenovateMarker`'s matching logic (§2) is graph-layer judgment, not a GitLab-REST primitive.

### 5. SSE / progress reporting

No new event type. Reuses `iac_pipeline_progress` exactly as `detectFleetUpgrade` and `watchPipeline` already do (§2). The frontend's existing pipeline-progress card renders whatever `status` string arrives verbatim (per the SIO-993 precedent noted at `nodes.ts:7848-7851`), so no frontend change is needed — `"renovate: triggered"` and subsequent MR-poll status lines render exactly like `"fleet: locked"` or `"plan succeeded"` do today.

## Files changed

| File | Change |
|---|---|
| `packages/agent/src/iac/state.ts` | Add `"renovate-integration-update"` to `INTENT_VALUES` |
| `packages/agent/src/iac/nodes.ts` | New classifier prompt bucket; 5 new node functions (`extractRenovateTarget`, `resolveRenovateMarker`, `renovateTriggerGate`, `triggerRenovateUpdate`, `watchRenovateMr`); `findGitlabProxyTool` helper |
| `packages/agent/src/iac/graph.ts` | Register 5 nodes; add `"renovate-integration-update"` branch to `intentTarget`/`INTENT_TARGETS`; wire detect→gate→apply→watch→teardown edges |
| `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` | New pure helper `parseDashboardEntries` (shares the marker regex with `tickDashboardCheckboxes`); new tool `gitlab_list_merge_requests_by_source_branch`; both unit-tested in `gitlab.test.ts` |
| `packages/mcp-server-elastic-iac/src/tools/tool-classification.ts` | Add `gitlab_list_merge_requests_by_source_branch` to `READ_ONLY_TOOLS` |
| `packages/mcp-server-elastic-iac/src/__tests__/tools-list-snapshot.json` | Regenerate (additive) for the new tool's surface |

No changes to `DATASOURCE_TO_MCP_SERVER`. `gitlab_get_issue` is an existing native tool with its own classification in `mcp-server-gitlab`, untouched.

## Testing

- `parseDashboardEntries`: TDD, same pattern as `tickDashboardCheckboxes`'s test suite (`gitlab.test.ts`) — multi-entry body, no entries, malformed/missing marker comment, already-ticked lines still parsed (marker extraction is independent of checkbox state).
- `resolveRenovateMarker`'s substring-matching logic: pure and unit-testable in isolation (extract as its own small function, not inlined in the node, so it gets the same TDD treatment as `findPipelineScheduleId`) — 0 matches, 1 match, 2+ matches (ambiguous), case-insensitivity.
- `gitlab_list_merge_requests_by_source_branch`: covered by the package's `tools-list-snapshot.test.ts` regeneration (surface-shape lock) — no separate pure-helper test needed since it's a thin `gitlabFetch` passthrough, matching how `gitlab_get_pipeline`/`gitlab_get_merge_request` (equally thin) have no dedicated unit test either.
- Graph wiring: extend the existing `graph.ts` structural test (if one exists covering `INTENT_TARGETS`/node count, per the "verified node count" convention CLAUDE.md documents for the main graph) to cover the new intent's edges.
- Manual verification: exercise the full turn against the real GitLab project once implemented (per this repo's `feedback_validate_every_claim_against_source` discipline) — trigger on a known pending dashboard entry, confirm the MR appears, confirm a 0-match and 2+-match phrasing both produce the disambiguation message instead of a silent wrong pick.
