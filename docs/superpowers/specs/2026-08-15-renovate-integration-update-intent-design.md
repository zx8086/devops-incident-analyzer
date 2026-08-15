# Renovate integration-update intent for the elastic-iac graph

Date: 2026-08-15
Origin: follow-up to [SIO-1470](https://linear.app/siobytes/issue/SIO-1470/add-renovate-on-demand-mr-trigger-tools-to-mcp-server-elastic-iac) (merged PR [#662](https://github.com/zx8086/devops-incident-analyzer/pull/662)), which added two GitLab MCP tools (`gitlab_unschedule_renovate_branches`, `gitlab_play_pipeline_schedule`) to `packages/mcp-server-elastic-iac` but wired them into nothing. This spec is the orchestration layer that makes the outcome real: a user says "update prometheus on eu-b2b" and the agent triggers the on-demand Renovate run and reports back the resulting MR.

## Problem

SIO-1470 built the *mechanism* — the two GitLab REST calls a human today performs by hand (tick a Dependency Dashboard checkbox, play the Renovate pipeline schedule). Nothing in the LangGraph pipeline calls them. The elastic-iac graph's existing `gitops` intent authors Terraform diffs itself (via `draftChange`/`gitlab_commit_file(s)`/`gitlab_create_merge_request`) and has no concept of "trigger an existing dependency-bot workflow instead of authoring a diff." A request like "update prometheus on eu-b2b" today either misclassifies into `gitops` (which would try to hand-author a version bump the agent has no business computing — Renovate already does this) or `fleet-upgrade` (which is Fleet agent *binaries*, a different axis entirely — see `nodes.ts:806-809`'s explicit "NOT fleet-upgrade" carve-out for deployment/cluster version).

## Scope

In scope: one new intent, its 5-node sub-flow, one new pure helper in `mcp-server-elastic-iac`, and the minimal cross-datasource tool-lookup addition needed to discover the Dependency Dashboard issue by title via the existing native GitLab MCP proxy (no new MCP tool).

Out of scope (unchanged from the original Renovate handover): merge/apply automation, selection-policy beyond "one deployment + one integration per request", a dedicated service-account token (this reuses `ELASTIC_IAC_GITLAB_TOKEN`, same as every other `mcp-server-elastic-iac` tool today), and any change to `DATASOURCE_TO_MCP_SERVER`'s 1:1 mapping.

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

`classifyIacIntent`'s LLM prompt (`nodes.ts:798-829`) gets one new bucket, inserted after the existing `fleet-upgrade` line (whose own text already explicitly disambiguates itself from cluster-version `gitops` — the new bucket needs the same explicit disambiguation against both neighbors):

> `'renovate-integration-update'`: a request to update an INTEGRATION PACKAGE (e.g. prometheus, fleet-server, a specific Elastic Agent integration) to its latest version on a deployment, via the existing dependency-bot automation — "update prometheus on eu-b2b", "bump the fleet-server integration for ap-cld", "get the latest kafka integration on b2b". This is NOT a deployment/cluster version change (that's 'gitops') and NOT a Fleet AGENT BINARY upgrade (that's 'fleet-upgrade'). The tell: the thing being updated is a named *integration/package* the deployment ingests data through, not the cluster itself or the enrolled agents.

No new deterministic pre-LLM guard is needed — unlike the `gitops-amend`/`pipeline-status` guards (which exist because they must override *conversational* ambiguity on a follow-up turn), this intent is a same-shape first-turn classification the LLM prompt already handles adequately, matching how `fleet-upgrade`/`drift`/`synthetics-drift` also rely on the prompt alone.

### 2. Sub-flow: 5 nodes, mirroring `detectFleetUpgrade`'s detect → gate → apply → teardown shape

```
classifyIacIntent --(intent=renovate-integration-update)--> extractRenovateTarget
  --> resolveRenovateMarker --(exactly 1 match)--> renovateTriggerGate --(approved)--> triggerRenovateUpdate --> watchRenovateMr --> teardown
                             --(0 or 2+ matches)--> teardown (disambiguation message, no gate)
  renovateTriggerGate --(declined)--> teardown
```

This is the same shape as `detectFleetUpgrade`/`fleetUpgradeGate`/`applyFleetUpgrade` → `teardown` (`graph.ts:159-165,296-309`), extended by one extra detect-stage node because target *resolution* (matching free text to a live marker) is a separate concern from target *extraction* (parsing the user's words) — collapsing them into one node would make the 0/2+-match early-exit harder to express as a clean conditional edge.

**`extractRenovateTarget`** — one small LLM call, same shape as `classifyIacIntent`'s own classification call (`llm.invoke([new SystemMessage(sys), ...recentMessages(state)])`, `nodes.ts:832`): extracts `{ deployment: string, integration: string }` from the request. On extraction failure (either field empty), routes straight to `teardown` with a clarifying message — no separate node needed for this, handled inline like `watchPipeline`'s early-return pattern (`nodes.ts:7801-7805`).

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

**`watchRenovateMr`** — reuses `watchPipeline`'s exact bounded poll-loop shape (`nodes.ts:7838-7861`): same `IAC_PIPELINE_POLL_INTERVAL_MS`/`IAC_PIPELINE_POLL_BUDGET_MS` env vars (10s/90s defaults via `readPositiveMsEnv`), same `while (Date.now() < deadline)` structure, same `dispatchCustomEvent("iac_pipeline_progress", ...)` mid-loop emission. The one difference: it polls for MR *existence* (`gitlab_list_merge_requests` filtered `state=opened&source_branch=renovate/<marker>`, an existing `mcp-server-elastic-iac` tool — confirm it accepts a `source_branch` filter arg; if not, filter client-side over its unfiltered response, the same client-side-filter approach `findPipelineScheduleId` already uses) rather than polling an existing pipeline to a terminal status. On timeout, returns the same "still running, ask again" UX as `watchPipeline`'s own budget-exceeded path — no new mechanism, no new user-facing behavior class.

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
| `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` | New pure helper `parseDashboardEntries` (shares the marker regex with `tickDashboardCheckboxes`), unit-tested in `gitlab.test.ts` |

No changes to `packages/mcp-server-elastic-iac/src/tools/tool-classification.ts` (no new MCP tool registered — `parseDashboardEntries` is a plain function, and `gitlab_get_issue` is an existing native tool with its own classification in `mcp-server-gitlab`, untouched). No changes to `DATASOURCE_TO_MCP_SERVER`.

## Testing

- `parseDashboardEntries`: TDD, same pattern as `tickDashboardCheckboxes`'s test suite (`gitlab.test.ts`) — multi-entry body, no entries, malformed/missing marker comment, already-ticked lines still parsed (marker extraction is independent of checkbox state).
- `resolveRenovateMarker`'s substring-matching logic: pure and unit-testable in isolation (extract as its own small function, not inlined in the node, so it gets the same TDD treatment as `findPipelineScheduleId`) — 0 matches, 1 match, 2+ matches (ambiguous), case-insensitivity.
- Graph wiring: extend the existing `graph.ts` structural test (if one exists covering `INTENT_TARGETS`/node count, per the "verified node count" convention CLAUDE.md documents for the main graph) to cover the new intent's edges.
- Manual verification: exercise the full turn against the real GitLab project once implemented (per this repo's `feedback_validate_every_claim_against_source` discipline) — trigger on a known pending dashboard entry, confirm the MR appears, confirm a 0-match and 2+-match phrasing both produce the disambiguation message instead of a silent wrong pick.
