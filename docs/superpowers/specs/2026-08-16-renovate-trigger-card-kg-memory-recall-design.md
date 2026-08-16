# Renovate trigger card: KG + Agent Memory recall — design

## Context

The `renovate_trigger_choice` approval card (enriched with Kibana/changelog data in [PR #666](https://github.com/zx8086/devops-incident-analyzer/pull/666)) shows no knowledge-graph or agent-memory content before the operator approves — unlike every sibling approval card in this codebase. The user flagged this directly: "we ha[ve] kg and agentic memory at every stage!!!! config change, fleet up[grade], this should be no similar[ly equipped], follow those paths."

Verified live: this is a real gap, not by-design behavior. `graphEnrichIac`/`memoryEnrichIac` (the config-change/gitops lane's KG+memory enrichment nodes) are wired only off `readClusterState` in `graph.ts`, which `renovate-integration-update` never reaches — same as the `fleet-upgrade` intent. But `fleet-upgrade` already solved this exact problem: its own gate-card node (`detectFleetUpgrade`) does its own pre-approval KG read (`recallDeploymentKgChanges`) and memory read (`recallPriorFleetUpgrades`), documented explicitly in the code: *"The fleet lane bypasses graphEnrichIac, so detectFleetUpgrade reads the KG itself"* (`packages/agent/src/iac/nodes.ts:12072-12079`). `renovate-integration-update` is in the identical situation (it also bypasses `graphEnrichIac`) but never got the equivalent reads added when `enrichRenovateTarget` was built.

## What already exists (reusable as-is)

- **`recallDeploymentKgChanges(deployment: string): Promise<string>`** (`nodes.ts:12080-12093`) — generic, not gitops- or fleet-specific. Reads the KG's prior `ConfigChange`s for a deployment via `priorChangesForDeployment`/`buildIacGraphContext`, gated on `isKnowledgeGraphEnabled()`, soft-fails to `""` on any error. Callable directly, no modification needed.
- **The durable renovate-trigger fact** (`buildRenovateFactAnnotations`, `nodes.ts:10891-10898`, written by `teardownIac` once `renovateMrUrl` is set) already carries `kind: "renovate-trigger"`, `deployment`, and `marker` (e.g. `renovate/ap-cld-elastic_agent` — uniquely identifies deployment+integration together). This is exactly what a new memory-recall function needs to filter on; no schema change to the write side.
- **`recallPriorFleetUpgrades(deployment, version): Promise<string>`** (`nodes.ts:12055-12069`) is the direct template for the new recall function: `searchAgentMemory("elastic-iac", "", {deployment, kind: "..."}, 8, {deterministic: true})`, soft-fail to `""`, render via a small local formatter.
- **The `<details open>` two-panel card layout** (`FleetUpgradeChoiceCard.svelte:114-140`) is the exact UI pattern to replicate: "Recent changes (knowledge graph)" + "Prior upgrades (memory)", each gated on presence, each rendering via `MarkdownRenderer`.

## Design

### New function: `recallPriorRenovateTriggers`

Mirrors `recallPriorFleetUpgrades` exactly, scoped to deployment **and** the resolved marker (per user decision: scope to the specific integration, not just the deployment) — a marker uniquely identifies "this integration on this deployment" (e.g. `renovate/ap-cld-elastic_agent`), so filtering on it directly answers "have we triggered *this* integration before" rather than a noisier "any Renovate trigger on this deployment."

```ts
// The renovate-trigger twin of recallPriorFleetUpgrades (SIO-971) -- deployment+marker-scoped
// recall of prior Renovate triggers for this EXACT integration, so the gate card can show "we've
// triggered this integration before" (and whether it produced an MR). Filters on the SAME keys
// buildRenovateFactAnnotations stamps (kind:"renovate-trigger", deployment, marker). Soft-fails to
// "" so a memory outage never blocks the gate. agent-memory backend only (file backend never
// writes this fact in the first place -- see teardownIac's existing gate).
export async function recallPriorRenovateTriggers(deployment: string, marker: string): Promise<string> {
	if (selectedBackend() !== "agent-memory" || !deployment || !marker) return "";
	try {
		const hits = await searchAgentMemory("elastic-iac", "", { deployment, marker, kind: "renovate-trigger" }, 8, {
			deterministic: true,
		});
		return renderRenovateLearnings(hits);
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error), deployment, marker },
			"iac renovate trigger: prior-trigger recall failed; continuing without it",
		);
		return "";
	}
}

// Renders recalled renovate-trigger facts as a markdown bullet list. "" for no hits (panel stays
// hidden). Mirrors renderFleetLearnings' shape; renovate facts carry mr_url (not version/pipeline),
// so the tag differs.
function renderRenovateLearnings(hits: MemorySearchHit[]): string {
	if (hits.length === 0) return "";
	return dedupeHitsBy(hits, (h) => h.annotations.mr_url ?? h.text)
		.map((h) => {
			const mrUrl = h.annotations.mr_url;
			return mrUrl ? `- ${h.text} [${mrUrl}]` : `- ${h.text}`;
		})
		.join("\n");
}
```

### Wiring into `enrichRenovateTarget`

Both reads run in parallel alongside (not blocking) the existing Kibana/changelog work — added right after `resolveKibanaConfig`/before the return, once `state.renovateMarker` is known (it always is by the time `enrichRenovateTarget` runs — `resolveRenovateMarker` sets it before routing here):

```ts
const [renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
	recallDeploymentKgChanges(target.deployment),
	recallPriorRenovateTriggers(target.deployment, marker.marker),
]);
```

Both are best-effort (already soft-fail internally) — no new try/catch needed at the call site, matching `detectFleetUpgrade`'s own `Promise.all` usage (`nodes.ts:12272-12275`).

### State fields (2 new, top-level on `IacStateType`, alongside the existing `renovate*` fields)

```ts
renovateRecentChanges: Annotation<string>({ reducer: last, default: () => "" }),
renovatePriorTriggers: Annotation<string>({ reducer: last, default: () => "" }),
```
Both added to `TURN_START_RESET` in the same commit (the PR #663/#666 lesson, twice-learned already — do not omit this again).

### Interrupt payload (`renovateTriggerGate`)

Add both fields to the existing `interrupt({...})` call, same pattern as the 4 enrichment fields already there:
```ts
recentChanges: state.renovateRecentChanges,
priorTriggers: state.renovatePriorTriggers,
```

### SSE schema (`packages/shared/src/agent-state.ts`)

Add two more optional string fields to the `renovate_trigger_choice` variant:
```ts
recentChanges: z.string().optional(),
priorTriggers: z.string().optional(),
```

### Reducer + `sse-pump.ts`

`RenovateTriggerChoice` interface gains `recentChanges?: string` and `priorTriggers?: string`; the reducer case and `emitIacInterrupt`'s defensive-parse spread both thread them through, identical to how `installedVersion`/`targetVersion`/`policyCount`/`changelog` were added in PR #666.

### Card (`RenovateTriggerChoiceCard.svelte`)

Two new `<details open>` panels, inserted after the existing stat-tile grid and before the changelog `<details>` (matching `FleetUpgradeChoiceCard`'s ordering: KG panel, then memory panel, then the rest):

```svelte
{#if prompt.recentChanges}
  <details class="mt-2" open>
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Recent changes (knowledge graph)</summary>
    <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
      <MarkdownRenderer content={prompt.recentChanges} />
    </div>
  </details>
{/if}

{#if prompt.priorTriggers}
  <details class="mt-2" open>
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Prior triggers (memory)</summary>
    <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
      <MarkdownRenderer content={prompt.priorTriggers} />
    </div>
  </details>
{/if}
```
Requires importing `MarkdownRenderer` into this component (not currently imported — `FleetUpgradeChoiceCard` already does, same import line to copy).

## What this does NOT do

- Does not change `graphEnrichIac`/`memoryEnrichIac` or their `readClusterState`-only wiring — this stays consistent with the fleet-upgrade precedent (a dedicated lane-local read, not a graph-topology change).
- Does not add a write-side KG node for renovate triggers (e.g. no new `ConfigChange` node type for "Renovate triggered") — out of scope; this spec is read-only recall for the gate card, matching what fleet-upgrade actually built (fleet-upgrade also has no fleet-specific KG *write* node, only the read).
- Does not change the durable Agent Memory fact's shape (`buildRenovateFactAnnotations`) — the existing `deployment`+`marker` annotations are already sufficient to filter on.

## Verification

- `bun test packages/agent/src/iac/renovate-integration.test.ts` — new tests for `recallPriorRenovateTriggers` (mocking `searchAgentMemory`) mirroring the existing `recallPriorFleetUpgrades` test style (find it in `fleet-upgrade.test.ts` and match its mocking convention).
- `bun run typecheck && bun run lint` from repo root.
- Manual/live probe: after this ships, trigger the SAME deployment+integration pair twice in a row (e.g. `ap-cld`/`elastic_agent` again) — the second trigger's card should show a real "Prior triggers (memory)" panel referencing the first run's MR, since the first run's durable fact will have been written by then. The "Recent changes (knowledge graph)" panel requires `KNOWLEDGE_GRAPH_ENABLED=true` and a real prior `ConfigChange` on that deployment to populate (may show empty/hidden in this environment depending on KG state — that's expected, matches fleet-upgrade's own documented behavior).
