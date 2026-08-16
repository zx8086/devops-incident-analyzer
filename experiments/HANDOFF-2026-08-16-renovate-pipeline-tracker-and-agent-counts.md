# Handover: Renovate pipeline-progress stage tracker + affected-policy agent counts

**Date:** 2026-08-16
**Ticket(s):** Not yet filed in Linear -- create on session start, per this repo's "every approved plan needs a Linear issue" rule. Suggested split (two separate issues, since they are independent and one is a bug / one is an enhancement):
- Issue A (bug): "Renovate lane: pipeline-progress stage tracker never advances (`node_start`/`node_end` gap)"
- Issue B (enhancement): "Renovate card: show per-policy agent count in Affected Policies list"
**Parent epic:** None -- both are follow-ups discovered live-testing [SIO-1475](https://linear.app/siobytes/issue/SIO-1475/renovate-agent-follow-up-check-again-guard-deployment-wide-trigger) (merged, [PR #671](https://github.com/zx8086/devops-incident-analyzer/pull/671)).
**Repo state:** branch `main`, HEAD `016f1c9f` (SIO-1477, merged after SIO-1475). This worktree (`sio-1475-renovate-followup-history`) is currently on `3b68437d`, one commit behind `main`'s current tip on unrelated work -- **start the new work from a fresh branch off `main` at `016f1c9f` or later, not from this worktree.**
**Suggested branch name:** `sio-XXXX-renovate-pipeline-tracker-and-agent-counts` (split into two branches if filing as two separate Linear issues -- recommended, since the two fixes touch non-overlapping files and have independent verification paths).

## TL;DR

Two unrelated gaps found while live-testing the Renovate integration-upgrade lane in the elastic-iac agent (screenshots from a real `http://localhost:5173` run triggering "In the ap-cld deployment, upgrade the 'Windows' integration").

1. **Bug:** the `StreamingProgress.svelte` stage tracker (the pill row: "Parsing — Reading state — Checking — ... — Watching pipeline") never advances during a Renovate trigger -- it sits stuck on "Starting..." with every pill grey, even though the pipeline is actually progressing correctly (confirmed by the separate "Pipeline progress" panel below it, which correctly shows "Pipeline: renovate: triggered"). Root cause: the Renovate lane's 6-7 LangGraph node ids were never added to `PIPELINE_NODES` in `apps/web/src/lib/server/sse-pump.ts`, so the server-side SSE gate silently drops every `node_start`/`node_end` trace event for this lane. This is the exact same gap SIO-935 fixed for the fleet-upgrade lane -- the fix here is to repeat that precedent for Renovate.
2. **Enhancement:** the Renovate trigger-choice card's "Affected policies (N)" list (e.g. `ap_windows_prod_windows`, `ap_windows_nonprod_windows`) shows bare policy names only. Add a per-policy agent/host count, e.g. `ap_windows_prod_windows (86 Agents)`. The backend already calls Kibana Fleet's `/api/fleet/package_policies` per policy but discards every field except `name` -- the fix is almost certainly available in the same API response already being fetched (Kibana's Fleet API is documented to include an `agents` count field per package-policy list item), not a new API call, but this must be **live-verified against a real deployment** before trusting the field name, since no other code in this repo parses that endpoint's response to confirm it.

Success looks like: (1) triggering a Renovate update shows the same kind of live-advancing pill row Fleet-upgrade and drift-reconcile already show, ending on a real terminal state instead of frozen "Starting..."; (2) the Affected Policies list shows a count per policy sourced from real Kibana data, gracefully omitted (not "undefined" or "0") if the API doesn't return it for a given policy.

## Context -- how these were found

Both were discovered live-testing SIO-1475 (Renovate follow-up "check again" guard + deployment-wide trigger history, spec `docs/superpowers/specs/2026-08-16-renovate-followup-and-history-design.md`, plan `docs/superpowers/plans/2026-08-16-renovate-followup-and-history.md`, merged as [PR #671](https://github.com/zx8086/devops-incident-analyzer/pull/671)) and its predecessor SIO-1474 (Kibana Fleet display-name-to-slug resolution, [PR #669](https://github.com/zx8086/devops-incident-analyzer/pull/669)). Neither gap blocks SIO-1475's own acceptance criteria (which were about follow-up routing and deployment-history recall, not the stage tracker or policy-count display) -- they're adjacent UX gaps noticed while eyeballing the live UI during that work's own verification pass, and were explicitly deferred to a follow-up session rather than bundled into SIO-1475's already-large diff.

The "Affected policies" feature itself is from SIO-1473 (`packages/agent/src/iac/nodes.ts:544` comment cites it directly) -- see `docs/code-review-bakeoff.md`'s PR #668 entry for that feature's own review history if useful background.

## Where the bodies are buried

### Issue A: stage tracker never advances for the Renovate lane

**The gate that silently drops every Renovate node's trace event** -- `apps/web/src/lib/server/sse-pump.ts:57-115`, the `PIPELINE_NODES` Set:

```ts
const PIPELINE_NODES = new Set([
	"classify", "normalize", "entityExtractor", "queryDataSource", "align", "aggregate",
	"extractFindings", "checkConfidence", "validate",
	"proposeInvestigate", "proposeMonitor", "proposeEscalate", "aggregateMitigation",
	"responder", "followUp", "detectTopicShift",
	// elastic-iac maker graph nodes (separate graph; harmless for the incident graph).
	"bootstrap", "parseIntent", "readClusterState", "guard", "draftChange",
	"reviewPlan", "reviewGate", "openMr", "watchPipeline", "teardown",
	// SIO-882: elastic-iac drift sub-flow nodes.
	"detectDrift", "reconcileGate", "reconcileStack", "advanceDrift",
	// SIO-902: elastic-iac synthetics drift sub-flow nodes.
	"detectSyntheticsDrift", "syntheticsPushGate", "pushSynthetics",
	// SIO-935: elastic-iac fleet-upgrade sub-flow nodes. Without these the on_chain_start/
	// on_chain_end gate below drops fleet node events, so the tracing pills never light up
	// during a fleet upgrade (two-leg flow: detectFleetUpgrade -> PAUSE at fleetUpgradeGate
	// -> applyFleetUpgrade on resume).
	"detectFleetUpgrade", "fleetUpgradeGate", "applyFleetUpgrade",
	// SIO-1126: HIL learning lane nodes (incident-analyzer "learn from TICKET-123").
	"learnFetchTicket", "learnMatchIncident", "learnMatchGate", "learnDistill",
	"learnReviewGate", "applyLearnings",
]);
```

**None of the Renovate lane's node ids appear here** (confirmed by grep, zero hits). The graph wiring (`packages/agent/src/iac/graph.ts:186-192`) shows the real node names:

```ts
.addNode("extractRenovateTarget", extractRenovateTarget)
.addNode("resolveRenovateMarker", resolveRenovateMarker)
.addNode("enrichRenovateTarget", enrichRenovateTarget)
.addNode("renovateTriggerGate", renovateTriggerGate)
.addNode("triggerRenovateUpdate", triggerRenovateUpdate)
.addNode("watchRenovateMr", watchRenovateMr)
```

(There's also `resolveIntegrationSlug`, added by SIO-1474, wired ahead of `extractRenovateTarget`.)

The consuming gate at `sse-pump.ts:254-263`:

```ts
if (event.event === "on_chain_start" && event.name && PIPELINE_NODES.has(event.name)) {
	nodeStartTimes.set(event.name, Date.now());
	send({ type: "node_start", nodeId: event.name });
}
if (event.event === "on_chain_end" && event.name && PIPELINE_NODES.has(event.name)) {
	const startTime = nodeStartTimes.get(event.name);
	const duration = startTime ? Date.now() - startTime : 0;
	nodeStartTimes.delete(event.name);
	send({ type: "node_end", nodeId: event.name, duration });
	...
```

LangGraph fires `on_chain_start`/`on_chain_end` for every node regardless of this Set -- the Set is purely an SSE forwarding whitelist. Since Renovate's node names aren't in it, `node_start`/`node_end` events are silently never sent for this lane, `agent-reducer.ts`'s `activeNodes`/`completedNodes` (the two Sets/Maps `StreamingProgress.svelte` reads) never gain any Renovate node id, and the tracker has nothing to show.

**Frontend labels are also missing.** `apps/web/src/lib/node-labels.ts:63-92` defines three mutually-exclusive IaC label arrays -- `IAC_MAKER_NODES`, `IAC_DRIFT_NODES`, `IAC_FLEET_NODES` (the last one added by SIO-935, exact precedent to copy) -- but there is no `IAC_RENOVATE_NODES`.

**The mutual-exclusion selector has no Renovate branch either.** `apps/web/src/lib/components/StreamingProgress.svelte:31-39`:

```ts
const iacNodes = $derived.by(() => {
	const seen = (id: string) => activeNodes.has(id) || completedNodes.has(id);
	// SIO-935: fleet first -- a fleet run executes detect/gate/apply and never the drift or maker nodes.
	if (IAC_FLEET_NODES.some((n) => seen(n.id))) return IAC_FLEET_NODES;
	const isDrift = IAC_DRIFT_NODES.some((n) => seen(n.id));
	return isDrift ? IAC_DRIFT_NODES : IAC_MAKER_NODES;
});
```

Even if the node ids were added to `PIPELINE_NODES` and `node-labels.ts` today, this selector would still never return a Renovate-specific list -- it falls through to `IAC_MAKER_NODES` by default, which is exactly the wrong 8-stage list currently shown frozen in the screenshot.

**Why the "Pipeline progress" panel below it works fine, unrelated:** `triggerRenovateUpdate` and `watchRenovateMr` each call a *separate*, already-working event type:

```ts
// packages/agent/src/iac/nodes.ts:896 (triggerRenovateUpdate)
await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: triggered" });
// packages/agent/src/iac/nodes.ts:982 (watchRenovateMr)
await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: MR created" });
```

reduced into a free-text log array, structurally independent of the stage-pill tracker:

```ts
// apps/web/src/lib/stores/agent-reducer.ts:696-699
case "iac_pipeline_progress": {
	const label = event.pipelineId ? `Pipeline #${event.pipelineId}: ${event.status}` : `Pipeline: ${event.status}`;
	return { ...state, iacPipelineProgress: [...state.iacPipelineProgress, label] };
}
```

This explains the screenshot precisely: the text log is correct and advancing, the pill row is frozen, because they're two unrelated mechanisms and only one of them was wired for this lane.

### Issue B: affected-policies list has no agent count

**Card rendering** -- `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte:119-137`:

```svelte
{#if prompt.affectedPolicies && prompt.affectedPolicies.length > 0}
  <details class="mt-2">
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
      Affected policies ({prompt.policyCount ?? prompt.affectedPolicies.length})
    </summary>
    <ul class="mt-1 ml-3 list-disc space-y-0.5 text-xs text-tommy-navy/70">
      {#each prompt.affectedPolicies as name (name)}
        <li>{name}</li>
      {/each}
    </ul>
  </details>
{/if}
```

`prompt.affectedPolicies` is `string[]` -- bare names, no per-item structure.

**Backend source** -- `fetchAffectedPolicyNames` at `packages/agent/src/iac/nodes.ts:544-581`:

```ts
async function fetchAffectedPolicyNames(
	kibanaConfig: { url: string; apiKey: string },
	integration: string,
): Promise<string[]> {
	const safeIntegration = integration.replace(/["\\]/g, "");
	const kuery = `ingest-package-policies.package.name:"${safeIntegration}"`;
	const names: string[] = [];
	try {
		for (let page = 1; page <= AFFECTED_POLICIES_MAX_PAGES; page++) {
			const res = await fetch(
				`${kibanaConfig.url}/api/fleet/package_policies?kuery=${encodeURIComponent(kuery)}&page=${page}&perPage=${AFFECTED_POLICIES_PER_PAGE}`,
				{ headers: { Authorization: `ApiKey ${kibanaConfig.apiKey}` }, signal: AbortSignal.timeout(8_000) },
			);
			if (!res.ok) return names;
			const body = (await res.json()) as { items?: unknown; total?: unknown };
			const items = Array.isArray(body.items) ? body.items : [];
			names.push(
				...items
					.filter(
						(item): item is { name: string } =>
							typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
					)
					.map((item) => item.name),   // <-- every other field on `item` is discarded here
			);
			const total = typeof body.total === "number" ? body.total : names.length;
			if (names.length >= total || items.length === 0) break;
		}
		return names;
	} catch {
		return names;
	}
}
```

Called from `enrichRenovateTarget` (`nodes.ts:658-667`):

```ts
const [match, names] = await Promise.all([
	packagesListCall,
	fetchAffectedPolicyNames(kibanaConfig, target.integration),
]);
...
affectedPolicies = names;
```

**This is the exact fix point.** The type guard at `nodes.ts:568-571` and the `.map((item) => item.name)` at line 572 are what throw away any count field already present in the raw Kibana response -- **not** a missing API call. Kibana's Fleet API documents an `agents` field on each `/api/fleet/package_policies` list item (assigned-agent count for that policy), but **this has not been confirmed against this repo's own live deployment** -- no other code anywhere in this monorepo parses that endpoint's response shape to cross-check the field name. Live-verify first (see Verification section) before trusting `agents` as the literal key.

**Full 6-layer threading path for `affectedPolicies` today** (the new agent-count field needs the identical path, field-for-field):

| Layer | File:Line | Current field |
|---|---|---|
| 1. LangGraph state | `packages/agent/src/iac/state.ts:835` | `renovateAffectedPolicies: Annotation<string[]>({ reducer: last, default: () => [] })` |
| 2. Interrupt payload | `packages/agent/src/iac/nodes.ts:824` (inside `renovateTriggerGate`'s `interrupt({...})`, `nodes.ts:810-826`) | `affectedPolicies: state.renovateAffectedPolicies,` |
| 3. SSE Zod schema | `packages/shared/src/agent-state.ts:1274` (inside the `renovate_trigger_choice` schema, `1241-1276`) | `affectedPolicies: z.array(z.string()).optional(),` |
| 4. sse-pump.ts | `apps/web/src/lib/server/sse-pump.ts:756` (decl), `918-919` (forward) | `affectedPolicies?: unknown;` / `...(Array.isArray(obj.affectedPolicies) && obj.affectedPolicies.length > 0 && { affectedPolicies: obj.affectedPolicies })` |
| 5. agent-reducer.ts | `apps/web/src/lib/stores/agent-reducer.ts:329` (interface), `860` (assignment) | `affectedPolicies?: string[];` / `affectedPolicies: event.affectedPolicies,` |
| 6. Svelte card | `RenovateTriggerChoiceCard.svelte:119-137` | shown above |

## The fix (step-by-step)

### Issue A

1. **`packages/agent/src/iac/graph.ts`** -- no change needed; node names already fixed (`extractRenovateTarget`, `resolveIntegrationSlug`, `resolveRenovateMarker`, `enrichRenovateTarget`, `renovateTriggerGate`, `triggerRenovateUpdate`, `watchRenovateMr`). Just confirm the exact list via `grep -n '"resolveIntegrationSlug"\|"extractRenovateTarget"\|"resolveRenovateMarker"\|"enrichRenovateTarget"\|"renovateTriggerGate"\|"triggerRenovateUpdate"\|"watchRenovateMr"' packages/agent/src/iac/graph.ts` before writing the next step, since a node could theoretically be renamed between now and when this ticket starts.

2. **`apps/web/src/lib/server/sse-pump.ts`** -- add a new comment block + 7 ids to `PIPELINE_NODES` (insert after the SIO-935 fleet block, before the SIO-1126 HIL block, `sse-pump.ts:~104`), mirroring the SIO-935 comment style exactly:

```ts
	// SIO-XXXX: elastic-iac renovate integration-update sub-flow. Without these the
	// on_chain_start/on_chain_end gate below drops renovate node events, so the tracing
	// pills never light up during a Renovate trigger (resolveIntegrationSlug ->
	// extractRenovateTarget -> resolveRenovateMarker -> enrichRenovateTarget -> PAUSE at
	// renovateTriggerGate -> triggerRenovateUpdate -> watchRenovateMr).
	"resolveIntegrationSlug",
	"extractRenovateTarget",
	"resolveRenovateMarker",
	"enrichRenovateTarget",
	"renovateTriggerGate",
	"triggerRenovateUpdate",
	"watchRenovateMr",
```

3. **`apps/web/src/lib/node-labels.ts`** -- add a new `IAC_RENOVATE_NODES` array after `IAC_FLEET_NODES` (line 92), and add it to the `ALL_NODE_LABELS` spread (line 111):

```ts
// SIO-XXXX: renovate integration-update sub-flow. Mutually exclusive with
// maker/drift/fleet -- a renovate run only ever executes these seven nodes.
export const IAC_RENOVATE_NODES: readonly NodeLabel[] = [
	{ id: "resolveIntegrationSlug", activeLabel: "Resolving integration", completeLabel: "Resolved" },
	{ id: "extractRenovateTarget", activeLabel: "Reading request", completeLabel: "Request read" },
	{ id: "resolveRenovateMarker", activeLabel: "Finding update", completeLabel: "Update found" },
	{ id: "enrichRenovateTarget", activeLabel: "Gathering context", completeLabel: "Context gathered" },
	{ id: "renovateTriggerGate", activeLabel: "Awaiting approval", completeLabel: "Approved" },
	{ id: "triggerRenovateUpdate", activeLabel: "Triggering update", completeLabel: "Triggered" },
	{ id: "watchRenovateMr", activeLabel: "Watching for MR", completeLabel: "MR found" },
] as const;
```

   Decide labels with judgment -- these are a starting proposal, not verbatim-mandatory; keep them short like the existing ones (1-3 words, present participle for active, past tense for complete).

4. **`apps/web/src/lib/components/StreamingProgress.svelte`** -- import `IAC_RENOVATE_NODES` and add a branch to `iacNodes` (lines 31-39), checked **before** the fleet check or after -- order matters only in that all three sub-flows are mutually exclusive in practice, so any order is safe, but for consistency add it in the same position order as `node-labels.ts`'s comment ordering (after fleet):

```ts
const iacNodes = $derived.by(() => {
	const seen = (id: string) => activeNodes.has(id) || completedNodes.has(id);
	// SIO-935: fleet first -- a fleet run executes detect/gate/apply and never the drift or maker nodes.
	if (IAC_FLEET_NODES.some((n) => seen(n.id))) return IAC_FLEET_NODES;
	// SIO-XXXX: renovate next -- a renovate run never executes fleet/drift/maker nodes.
	if (IAC_RENOVATE_NODES.some((n) => seen(n.id))) return IAC_RENOVATE_NODES;
	const isDrift = IAC_DRIFT_NODES.some((n) => seen(n.id));
	return isDrift ? IAC_DRIFT_NODES : IAC_MAKER_NODES;
});
```

5. No backend `dispatchCustomEvent` changes are needed -- LangGraph's automatic `on_chain_start`/`on_chain_end` tracing already fires for every node; the fix is purely about the SSE forwarding whitelist and the frontend label/selection arrays, exactly as SIO-935 proved for fleet-upgrade.

### Issue B

1. **Live-verify first** (see Verification section) -- confirm the exact field name and shape Kibana's `/api/fleet/package_policies` returns for agent/host counts on this deployment before writing any code. Do not assume `agents` is the literal key; the Kibana Fleet API has changed field names across versions before (this repo's own `withPackagePoliciesCount` comment at `nodes.ts:613-614` is evidence of exactly this kind of Fleet-API versioning care already taken elsewhere in this file -- read that comment for the established pattern of hedging against Fleet API shape assumptions).

2. **`packages/agent/src/iac/nodes.ts:544-581`** -- change `fetchAffectedPolicyNames`'s return type from `string[]` to an array of `{ name: string; agentCount: number | null }` (name required from the existing narrow-cast at lines 568-571; `agentCount` optional/nullable since the API may omit it or a policy may genuinely have 0 agents -- distinguish "not present in response" from "present as 0" if the live probe shows that distinction matters). Update the type guard to also read whatever the live probe confirms the count field is, and update the JSDoc/type accordingly. Rename the function or keep the name -- judgment call, but if renaming, grep the whole codebase for `fetchAffectedPolicyNames` first (it's referenced by name in this repo's own review history, e.g. `docs/code-review-bakeoff.md`'s PR #668 section) to avoid a stale doc reference elsewhere.

3. **`enrichRenovateTarget`** (`nodes.ts:658-667`) -- update the destructure/assignment; `affectedPolicies` on state likely becomes the new object-array shape, or keep `affectedPolicies: string[]` for backward-compat-within-this-branch and add a parallel `affectedPolicyAgentCounts: Record<string, number>` -- **this is a real design decision to make at implementation time**, not something this handover should hand-wave. Recommendation: prefer the object-array shape (`{name, agentCount}[]`) over a parallel map, since it keeps the name/count pairing atomic and avoids a second lookup at render time, but confirm this doesn't conflict with how `policyCount` (a separate, pre-existing field from the other Kibana call in the same function, used for the summary count) is computed -- read `nodes.ts` around the `policyCount` assignment before changing `affectedPolicies`'s shape, since the two fields currently come from two different Kibana calls in the same `Promise.all` and must stay independently correct.

4. **`packages/agent/src/iac/state.ts:835`** -- update `renovateAffectedPolicies`'s Annotation type to match the new shape.

5. **`packages/agent/src/iac/nodes.ts:824`** (`renovateTriggerGate`'s `interrupt()` call) -- no key rename needed if keeping `affectedPolicies` as the field name, just the value's shape changes.

6. **`packages/shared/src/agent-state.ts:1274`** -- update the Zod schema: `affectedPolicies: z.array(z.object({ name: z.string(), agentCount: z.number().nullable() })).optional(),` (adjust to whatever shape Step 2-3 settle on).

7. **`apps/web/src/lib/server/sse-pump.ts:756,918-919`** -- the defensive-parse type literal and forwarding spread need updating from `unknown` array-of-strings assumptions to the new shape; keep the existing "only forward if non-empty array" guard pattern.

8. **`apps/web/src/lib/stores/agent-reducer.ts:329,860`** -- update the `RenovateTriggerChoice` interface field type and the reducer assignment.

9. **`RenovateTriggerChoiceCard.svelte:119-137`** -- update the `{#each}` to render both name and count, gracefully omitting the count when null/absent (do not render "undefined Agents" or "null Agents"):

```svelte
{#each prompt.affectedPolicies as policy (policy.name)}
  <li>{policy.name}{#if policy.agentCount != null} ({policy.agentCount} Agent{policy.agentCount === 1 ? "" : "s"}){/if}</li>
{/each}
```

10. **Tests** -- this repo's TDD discipline applies (`superpowers:test-driven-development`). New/changed test coverage needed in `packages/agent/src/iac/renovate-integration.test.ts` (the existing home for all Renovate-lane tests, 131 tests as of PR #671) for: the updated `fetchAffectedPolicyNames` (or renamed equivalent) parsing a count field from a mocked Kibana response, and gracefully falling back to `agentCount: null` when the field is absent from a mocked response (mirrors this file's existing soft-fail testing style for every other Kibana/GitLab call in this lane).

## Verification

```bash
bun run typecheck && bun run lint && bun run test
```

Plus, per this ticket specifically:

**Issue A manual probe** (start the web app, no other servers needed for this specific check since it's purely SSE/UI wiring):
```bash
lsof -i :5173  # confirm free first
bun run --filter @devops-agent/web dev
```
Then in the browser, trigger a real Renovate update (e.g. "In the ap-cld deployment, upgrade the 'Windows' integration" or any integration known to have a pending Dependency Dashboard entry) and confirm the pill row advances through real stages instead of sitting on "Starting..." -- compare directly against how the Fleet-upgrade lane's pills behave for a like-for-like reference (e.g. "upgrade the fleet agent binary on ap-cld"). **Kill the dev server when done**, verify with `lsof -nP -iTCP:5173 -sTCP:LISTEN` returning nothing, per this repo's non-negotiable kill-every-service rule.

**Issue B manual probe** -- before writing code, curl Kibana Fleet directly (credentials from `.env`, not `.env.example`, per `feedback_validate_env_not_env_example` memory) to see the real response shape:
```bash
grep "^KIBANA_URL=\|^KIBANA_API_KEY=" .env  # or however this deployment's Kibana creds are named in this env file -- confirm key names first
curl -s "$KIBANA_URL/api/fleet/package_policies?kuery=ingest-package-policies.package.name:%22windows%22&perPage=5" \
  -H "Authorization: ApiKey $KIBANA_API_KEY" | jq '.items[0]'
```
Inspect the full item shape for whatever count field is present (look for `agents`, `agent_count`, or similar) before writing the type guard in Step 2 of the fix. If no count field is present in this Kibana version's response at all, that's a real finding -- report it back rather than fabricating a field, and consider whether a second API call (Fleet's `/api/fleet/agents?kuery=...` filtered by policy id, if that's a real endpoint on this deployment) would be needed instead. Do not guess; this probe is the actual gate for whether Issue B is a one-field addition or a bigger scope.

Then re-run the same live UI probe as Issue A (trigger a real Renovate update) and confirm the Affected Policies list shows real counts, not `undefined`/`0` placeholders, for at least one policy known to have agents assigned.

## Files to modify

| Package | File | Change |
|---|---|---|
| apps/web | `apps/web/src/lib/server/sse-pump.ts` | Issue A: add 7 renovate node ids to `PIPELINE_NODES` |
| apps/web | `apps/web/src/lib/node-labels.ts` | Issue A: add `IAC_RENOVATE_NODES`, include in `ALL_NODE_LABELS` |
| apps/web | `apps/web/src/lib/components/StreamingProgress.svelte` | Issue A: import + branch in `iacNodes` selector |
| packages/agent | `packages/agent/src/iac/nodes.ts` | Issue B: `fetchAffectedPolicyNames` return shape + `enrichRenovateTarget` wiring |
| packages/agent | `packages/agent/src/iac/state.ts` | Issue B: `renovateAffectedPolicies` Annotation type |
| packages/shared | `packages/shared/src/agent-state.ts` | Issue B: SSE Zod schema for `affectedPolicies` |
| apps/web | `apps/web/src/lib/server/sse-pump.ts` | Issue B: defensive-parse type + forwarding spread |
| apps/web | `apps/web/src/lib/stores/agent-reducer.ts` | Issue B: `RenovateTriggerChoice` interface + reducer |
| apps/web | `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte` | Issue B: render count per policy |
| packages/agent | `packages/agent/src/iac/renovate-integration.test.ts` | Issue B: new/updated tests for count parsing + graceful fallback |

## Workflow

1. Branch off `main` at or after `016f1c9f`.
2. File the Linear issue(s) first (see header) -- this repo requires a tracked issue before implementation starts.
3. Recommend `superpowers:brainstorming` (bounded path is probably right for Issue A -- it's a well-scoped mirror of an existing SIO-935 pattern in a repo that already has the flow; Issue B may also be bounded once the live Kibana probe confirms the field exists, but escalate to a short design doc if the probe reveals the count needs a second API call).
4. Linear status: In Progress when starting -- "started" resolves to "In Review" per this workspace's configured state mapping (`reference_linear_started_state_resolves_to_in_review` memory) -- Done only on explicit user approval, though note the merged-PR-link integration auto-transitions to Done on merge (observed on SIO-1475 itself) without a manual step.
5. Commit format: `SIO-XXXX: message`.
6. PR: create as ready-for-review (never draft), wait for the `Greptile Review` status check (`COMPLETED`/`SUCCESS`), triage both Greptile and CodeRabbit findings (verify-before-apply discipline), log the head-to-head to `docs/code-review-bakeoff.md`, then merge.

Commit message template:
```bash
git commit -m "$(cat <<'EOF'
SIO-XXXX: wire renovate lane node ids into the pipeline-progress tracker

EOF
)"
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Issue A: adding node ids to `PIPELINE_NODES` changes nothing because `StreamingProgress.svelte`'s selector branch was forgotten | Low if both steps done together | Both are in the same fix; test live before considering done -- a code-only "looks right" pass is not sufficient, per this repo's UI-testing discipline |
| Issue A: renovate node labels picked in this handover turn out confusing/misleading in the real live pill row | Medium | Labels are explicitly flagged above as a starting proposal, not mandatory -- adjust freely, the only hard constraint is the `id` matching the graph node name exactly |
| Issue B: Kibana Fleet API on this deployment's version doesn't expose a per-policy agent count in `/api/fleet/package_policies` at all | Medium -- unverified in this repo | The live curl probe in Verification is the actual gate; if absent, report back rather than fabricating, and consider a second Fleet Agents API call as a fallback design |
| Issue B: `policyCount` (separate pre-existing field, different Kibana call) and the new per-policy `agentCount` get confused as the same concept | Medium -- both are "counts" near each other in the same function | They are NOT the same: `policyCount` is the summary total from `/api/fleet/epm/packages`; the new field is a per-item count from `/api/fleet/package_policies`. Keep them as clearly distinct fields, do not conflate |
| Issue B: renaming `fetchAffectedPolicyNames` breaks a stale reference in `docs/code-review-bakeoff.md`'s PR #668 write-up | Low, cosmetic only | Grep before renaming; docs referencing a renamed function by name are a pre-existing pattern risk in this repo already, not blocking |

## Out of scope

- Any change to the Renovate lane's actual business logic (marker resolution, MR polling, KG writes, deployment-history recall) -- all of that is SIO-1475's already-merged, already-verified work. This handover is UI/observability polish only.
- Adding node ids for any other still-unwired lane beyond Renovate (if one is discovered during this work, note it and file a separate follow-up rather than scope-creeping this ticket).
- Changing how `policyCount` (the pre-existing summary count) is computed -- only the per-item `affectedPolicies` list gains a new field.
- Building a new Kibana Fleet Agents API integration if the live probe shows no count is available from the existing call -- that would be a real scope escalation requiring its own brainstorm/design step, not something to improvise mid-implementation.

## Related code references

- `apps/web/src/lib/node-labels.ts:86-92` -- the SIO-935 `IAC_FLEET_NODES` addition, the exact precedent Issue A's fix mirrors.
- `apps/web/src/lib/server/sse-pump.ts:101-104` -- the SIO-935 comment explaining precisely why a lane's node ids must be in `PIPELINE_NODES`, word-for-word the same reasoning that applies to Renovate.
- `packages/agent/src/iac/nodes.ts:613-614` -- existing comment about `withPackagePoliciesCount`, evidence of this file's established care around Kibana Fleet API shape assumptions; follow the same hedging discipline for the new agent-count field.
- `packages/agent/src/iac/nodes.ts:896`, `982` -- the two existing (working, keep as-is) `iac_pipeline_progress` dispatch calls in the Renovate lane; do not remove these when adding the new stage-tracker wiring, they serve a different, complementary purpose (free-text status log vs. structured stage pills).

## Memory references

- `reference_linear_pr_link_auto_transitions_to_done` -- merged-PR-link auto-transitions Linear to Done; don't be surprised if it happens again on this ticket without a manual action.
- `reference_linear_started_state_resolves_to_in_review` -- "In Progress"/"started" maps to this workspace's "In Review" state internally.
- `feedback_validate_env_not_env_example` -- use the real `.env`, not `.env.example`, for the Issue B Kibana probe's credentials.
- `feedback_verify_tool_schema_against_upstream_docs` and `feedback_tool_schema_enum_completeness_principle` -- both directly relevant to Issue B's live-verify-before-coding step; don't trust documented Kibana Fleet API shape without confirming against this deployment's actual response.
- `reference_ec_api_key_401_masks_deployment_resolution` -- if the live Kibana probe in Issue B returns a 401, check this isn't a masked deployment-resolution issue rather than a real auth failure, before concluding the count field doesn't exist.
