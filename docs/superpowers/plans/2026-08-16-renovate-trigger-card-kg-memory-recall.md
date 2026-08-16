# Renovate Trigger Card KG + Agent Memory Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show KG change-history and prior-Renovate-trigger memory recall on the `renovate_trigger_choice` approval card, mirroring the fleet-upgrade gate card's existing pattern exactly, closing the gap the user flagged directly.

**Architecture:** Reuse the existing `recallDeploymentKgChanges` function as-is (already generic, already reachable from `nodes.ts`). Add one new function `recallPriorRenovateTriggers` (deployment+marker-scoped agent-memory recall, filtering on the durable renovate-trigger fact's existing annotations — no write-side change needed). Both run in `enrichRenovateTarget` alongside the existing Kibana/changelog work. Thread two new string fields through the same 6 layers PR #666 already established for the enrichment fields (state → interrupt payload → SSE schema → reducer/sse-pump → card), landing as two new `<details open>` panels matching `FleetUpgradeChoiceCard`'s exact layout.

**Tech Stack:** TypeScript (Bun), LangGraph (`@langchain/langgraph`), Svelte 5 runes, Tailwind, the existing `memory-backend.ts` agent-memory client (`searchAgentMemory`/`selectedBackend`/`dedupeHitsBy`, already imported into `nodes.ts`).

**Spec:** `docs/superpowers/specs/2026-08-16-renovate-trigger-card-kg-memory-recall-design.md`

## Global Constraints

- No new environment variables or credentials — both reads use infrastructure that already exists (`isKnowledgeGraphEnabled()`/`getGraphStore()` for KG, `selectedBackend()`/`searchAgentMemory()` for memory).
- Both new reads are best-effort: on failure or when disabled, resolve to `""` (never throw, never set `blockedReason`) — matching `recallDeploymentKgChanges`'s and `recallPriorFleetUpgrades`'s existing soft-fail contract exactly. `enrichRenovateTarget` overall must still never block the approval gate.
- Any new state field added to `IacStateType` MUST be added to `TURN_START_RESET` in the same commit — the PR #663/#666 lesson, now the third time this exact rule applies to this sub-flow. Do not omit it again.
- TypeScript strict mode, no `any`.
- Tailwind-only styling in the Svelte card — no custom `<style>` blocks.
- TDD: write the failing test first for every new pure/testable function, watch it fail, then implement.
- Test mocking for agent-memory reads MUST use the `__setAgentMemoryClient` + `process.env.LIVE_MEMORY_BACKEND = "agent-memory"` pattern already established in `fleet-upgrade.test.ts`'s `recallPriorFleetUpgrades` tests — NOT a direct `mock()` on `searchAgentMemory`, which is a thin wrapper around the real client and would bypass the actual code path under test. See Task 1's brief for the exact pattern to copy.

---

### Task 1: `recallPriorRenovateTriggers` + `renderRenovateLearnings` pure/testable functions

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add both functions near `recallDeploymentKgChanges`/`recallPriorFleetUpgrades`/`renderFleetLearnings`, i.e. right after line 12093 where `recallDeploymentKgChanges` ends — keep all four "recall" functions colocated, matching this file's existing convention of grouping the fleet-upgrade recall helpers together)
- Test: `packages/agent/src/iac/fleet-upgrade.test.ts` — despite the "fleet" filename, this is where `recallDeploymentKgChanges`'s and `recallPriorFleetUpgrades`'s own tests already live (search the file for `describe("recallPriorFleetUpgrades (SIO-971)"` at line 1421 and `describe("recallDeploymentKgChanges (SIO-1462)"` at line 1509) — this file is this repo's established home for "gate card recall helper" tests regardless of which intent they serve. Add a new `describe("recallPriorRenovateTriggers (SIO-XXXX)", ...)` block immediately after the existing `recallDeploymentKgChanges` describe block (it ends around line 1540 — grep for the next `describe(` after that point to find the exact insertion line before writing).

**Interfaces:**
- Consumes: `searchAgentMemory`, `selectedBackend`, `dedupeHitsBy`, `MemorySearchHit` (all already imported into `nodes.ts` at the top of the file — no new imports needed), `log` (this file's existing logger instance).
- Produces:
```typescript
export async function recallPriorRenovateTriggers(deployment: string, marker: string): Promise<string>
```
Returns a markdown bullet list of prior renovate-trigger facts for this exact deployment+marker pair (empty string `""` if the agent-memory backend isn't selected, either argument is empty, no hits exist, or the recall errors). Consumed by Task 2 (`enrichRenovateTarget`).

- [ ] **Step 1: Write the failing tests**

First, read the existing `recallPriorFleetUpgrades` and `recallDeploymentKgChanges` describe blocks in full (`packages/agent/src/iac/fleet-upgrade.test.ts`, starting at line 1421) to confirm the exact `withTerminalFacts`-style mocking helper pattern and copy its structure faithfully — do not invent a new mocking style.

```typescript
// Append to packages/agent/src/iac/fleet-upgrade.test.ts, immediately after the existing
// describe("recallDeploymentKgChanges (SIO-1462)", ...) block.
import { recallPriorRenovateTriggers } from "./nodes.ts";

describe("recallPriorRenovateTriggers (SIO-XXXX)", () => {
	const prevBackend = process.env.LIVE_MEMORY_BACKEND;
	function withRenovateTriggerFacts(
		rows: Array<{ deployment: string; marker: string; mrUrl?: string; text?: string }>,
	) {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				// proves the recall filters on the SAME keys buildRenovateFactAnnotations stamps
				expect(opts?.annotations).toEqual({
					deployment: "ap-cld",
					marker: "renovate/ap-cld-elastic_agent",
					kind: "renovate-trigger",
				});
				return rows.map((r) => ({
					text: r.text ?? `Renovate update triggered on ${r.deployment} for '${r.marker}'.`,
					score: 0.9,
					annotations: {
						kind: "renovate-trigger",
						deployment: r.deployment,
						marker: r.marker,
						...(r.mrUrl && { mr_url: r.mrUrl }),
					},
				}));
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-XXXX - test stub for the AgentMemoryClient surface
		} as any);
	}
	function reset() {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient(null);
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	}

	test("renders prior renovate triggers as markdown with the MR URL tag", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withRenovateTriggerFacts([
			{
				deployment: "ap-cld",
				marker: "renovate/ap-cld-elastic_agent",
				mrUrl: "https://gitlab.example/x/-/merge_requests/518",
			},
		]);
		const out = await recallPriorRenovateTriggers("ap-cld", "renovate/ap-cld-elastic_agent");
		expect(out).toContain("Renovate update triggered on ap-cld for 'renovate/ap-cld-elastic_agent'");
		expect(out).toContain("[https://gitlab.example/x/-/merge_requests/518]");
		reset();
	});

	test("renders a fact with no mr_url without a trailing empty tag", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withRenovateTriggerFacts([{ deployment: "ap-cld", marker: "renovate/ap-cld-elastic_agent" }]);
		const out = await recallPriorRenovateTriggers("ap-cld", "renovate/ap-cld-elastic_agent");
		expect(out).toBe("- Renovate update triggered on ap-cld for 'renovate/ap-cld-elastic_agent'.");
		reset();
	});

	// A re-recorded trigger for the SAME MR must render once, not twice (mirrors SIO-973's
	// pipeline_id dedup for fleet-upgrade facts).
	test("dedups recall hits sharing an mr_url into a single bullet", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withRenovateTriggerFacts([
			{
				deployment: "ap-cld",
				marker: "renovate/ap-cld-elastic_agent",
				mrUrl: "https://gitlab.example/x/-/merge_requests/518",
			},
			{
				deployment: "ap-cld",
				marker: "renovate/ap-cld-elastic_agent",
				mrUrl: "https://gitlab.example/x/-/merge_requests/518",
			},
		]);
		const out = await recallPriorRenovateTriggers("ap-cld", "renovate/ap-cld-elastic_agent");
		expect(out.split("\n")).toHaveLength(1);
		reset();
	});

	test("returns '' when the agent-memory backend is not selected", async () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(await recallPriorRenovateTriggers("ap-cld", "renovate/ap-cld-elastic_agent")).toBe("");
		reset();
	});

	test("returns '' when no deployment is resolved", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(await recallPriorRenovateTriggers("", "renovate/ap-cld-elastic_agent")).toBe("");
		reset();
	});

	test("returns '' when no marker is resolved", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(await recallPriorRenovateTriggers("ap-cld", "")).toBe("");
		reset();
	});

	test("returns '' (no hits) when nothing prior exists", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withRenovateTriggerFacts([]);
		expect(await recallPriorRenovateTriggers("ap-cld", "renovate/ap-cld-elastic_agent")).toBe("");
		reset();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/fleet-upgrade.test.ts -t "recallPriorRenovateTriggers"`
Expected: FAIL — `recallPriorRenovateTriggers is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/agent/src/iac/nodes.ts`, immediately after `recallDeploymentKgChanges` (after line 12093):

```typescript
// The renovate-trigger twin of recallPriorFleetUpgrades (SIO-971) -- deployment+marker-scoped
// recall of prior Renovate triggers for this EXACT integration, so the gate card can show "we've
// triggered this integration before" (and its MR, if one was found). Filters on the SAME keys
// buildRenovateFactAnnotations stamps (kind:"renovate-trigger", deployment, marker) -- scoped to
// marker (not just deployment) per design decision, since a marker uniquely identifies "this
// integration on this deployment" and a deployment-only scope would mix in unrelated integrations'
// triggers. Soft-fails to "" so a memory outage never blocks the gate. agent-memory backend only
// (the file backend never writes this fact -- see teardownIac's existing gate).
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

// Renders recalled renovate-trigger facts as a markdown bullet list. "" for no hits (the gate
// card panel stays hidden). Mirrors renderFleetLearnings' shape; renovate facts carry mr_url (not
// version/pipeline_id), so the tag differs and dedup keys on mr_url instead of pipeline_id.
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/fleet-upgrade.test.ts -t "recallPriorRenovateTriggers"`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Run the full fleet-upgrade test file + typecheck**

Run: `cd packages/agent && bun test src/iac/fleet-upgrade.test.ts && bun run typecheck`
Expected: all tests pass (no regression on the existing fleet-upgrade/recallDeploymentKgChanges tests), 0 typecheck errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/fleet-upgrade.test.ts
git commit -m "SIO-XXXX: add recallPriorRenovateTriggers memory recall for the renovate gate card"
```

---

### Task 2: Wire both recalls into `enrichRenovateTarget`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`enrichRenovateTarget`, currently lines 476-547)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend the existing `describe("enrichRenovateTarget (SIO-XXXX)", ...)` block, starting at line 818)

**Interfaces:**
- Consumes: `recallDeploymentKgChanges` (already exported, same file, no import needed), `recallPriorRenovateTriggers` (from Task 1, same file).
- Produces: `enrichRenovateTarget`'s return type gains 2 new keys: `renovateRecentChanges: string`, `renovatePriorTriggers: string` — always present (never `undefined`), since both recall functions always resolve to at least `""`.

- [ ] **Step 1: Write the failing tests**

The existing `enrichRenovateTarget` tests in `renovate-integration.test.ts` do NOT set `LIVE_MEMORY_BACKEND=agent-memory` in their environment, so `selectedBackend()` defaults to `"file"` and `recallPriorRenovateTriggers` will short-circuit to `""` for every one of them automatically — **no changes needed to any existing test**. Add ONLY the following two new tests to the existing describe block (after its last existing test, before the closing `});` of the describe block):

```typescript
// Append inside the existing describe("enrichRenovateTarget (SIO-XXXX)", () => { ... }) block,
// after its last existing test.
test("threads recallDeploymentKgChanges' output onto renovateRecentChanges when the KG is enabled", async () => {
	process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
	process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
	global.fetch = mock(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
	// recallDeploymentKgChanges soft-fails to "" when KNOWLEDGE_GRAPH_ENABLED is unset (this test's
	// environment) -- assert the field is present and is a string, not that it's populated (a live
	// KG-populated case is out of scope for this unit test; recallDeploymentKgChanges has its own
	// coverage in fleet-upgrade.test.ts's "recallDeploymentKgChanges (SIO-1462)" describe block).
	const out = await enrichRenovateTarget(baseState() as IacStateType);
	expect(typeof out.renovateRecentChanges).toBe("string");
});

test("threads recallPriorRenovateTriggers' output onto renovatePriorTriggers when agent-memory has prior facts", async () => {
	process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
	process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
	process.env.LIVE_MEMORY_BACKEND = "agent-memory";
	global.fetch = mock(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
	const { __setAgentMemoryClient } = require("../memory-backend.ts");
	__setAgentMemoryClient({
		async ensureUser() {},
		async ensureSession() {},
		async addFacts() {},
		async addMessages() {},
		async searchMemory() {
			return [
				{
					text: "Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
					score: 0.9,
					annotations: {
						kind: "renovate-trigger",
						deployment: "eu-onboarding",
						marker: "renovate/eu-onboarding-elastic_agent",
						mr_url: "https://gitlab.example/x/-/merge_requests/518",
					},
				},
			];
		},
		async updateSession() {},
		async endSession() {},
		async checkHealth() {
			return { ok: true };
		},
		// biome-ignore lint/suspicious/noExplicitAny: SIO-XXXX - test stub for the AgentMemoryClient surface
	} as any);

	const out = await enrichRenovateTarget(baseState() as IacStateType);

	expect(out.renovatePriorTriggers).toContain("Renovate update triggered on eu-onboarding");
	expect(out.renovatePriorTriggers).toContain("[https://gitlab.example/x/-/merge_requests/518]");

	__setAgentMemoryClient(null);
});
```

Note for the implementer: check whether `renovate-integration.test.ts` already imports `require` usage anywhere (Bun supports both `require` and `import` in test files, and `fleet-upgrade.test.ts` uses `require("../memory-backend.ts")` inline specifically to reach the test-only `__setAgentMemoryClient` export without polluting the file's top-level static imports — follow that same inline-require convention here rather than adding a new top-level import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "renovateRecentChanges|renovatePriorTriggers"`
Expected: FAIL — `out.renovateRecentChanges`/`out.renovatePriorTriggers` are `undefined` (the return object doesn't have these keys yet).

- [ ] **Step 3: Implement**

In `packages/agent/src/iac/nodes.ts`, inside `enrichRenovateTarget` (currently lines 476-547), add the two recalls and thread them into the return. Replace:

```typescript
	const changelog = resolvedTargetVersion
		? filterChangelogRange(await fetchRenovateChangelog(target.integration), installedVersion, resolvedTargetVersion)
		: [];

	return {
		renovateInstalledVersion: installedVersion,
		renovateTargetVersion: resolvedTargetVersion,
		renovatePolicyCount: policyCount,
		renovateChangelog: changelog,
	};
}
```

with:

```typescript
	const [changelog, renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
		resolvedTargetVersion
			? filterChangelogRangeAsync(target.integration, installedVersion, resolvedTargetVersion)
			: Promise.resolve([] as ChangelogEntry[]),
		recallDeploymentKgChanges(target.deployment),
		recallPriorRenovateTriggers(target.deployment, marker.marker),
	]);

	return {
		renovateInstalledVersion: installedVersion,
		renovateTargetVersion: resolvedTargetVersion,
		renovatePolicyCount: policyCount,
		renovateChangelog: changelog,
		renovateRecentChanges,
		renovatePriorTriggers,
	};
}
```

**Important implementer note on the changelog line:** the ORIGINAL code was `const changelog = resolvedTargetVersion ? filterChangelogRange(await fetchRenovateChangelog(...), ...) : []` -- a synchronous ternary with an `await` INSIDE one branch, not itself awaitable as a `Promise.all` entry. To fold it into the new `Promise.all` alongside the two new recalls (so all three run concurrently rather than the changelog fetch blocking before the KG/memory reads start), you need an async wrapper. Do NOT invent a new `filterChangelogRangeAsync` helper function -- that name is illustrative only. Instead, use an inline async IIFE for just that one branch:

```typescript
	const [changelog, renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
		(async () =>
			resolvedTargetVersion
				? filterChangelogRange(await fetchRenovateChangelog(target.integration), installedVersion, resolvedTargetVersion)
				: [])(),
		recallDeploymentKgChanges(target.deployment),
		recallPriorRenovateTriggers(target.deployment, marker.marker),
	]);
```
This preserves the exact original changelog logic (including the `resolvedTargetVersion` guard) while running it concurrently with the two new best-effort reads instead of sequentially after them -- matching `detectFleetUpgrade`'s own `Promise.all([recallPriorFleetUpgrades(...), recallDeploymentKgChanges(...)])` concurrency pattern (nodes.ts:12272-12275) that this task is extending.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "enrichRenovateTarget"`
Expected: PASS, all tests (13 existing + 2 new = 15).

- [ ] **Step 5: Run the full renovate test file + typecheck**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts && bun run typecheck`
Expected: all tests pass, 0 typecheck errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: wire KG + memory recall into enrichRenovateTarget"
```

---

### Task 3: State fields + `TURN_START_RESET`

**Files:**
- Modify: `packages/agent/src/iac/state.ts` (add 2 fields after `renovateChangelog`, currently ending at line 812)
- Modify: `packages/agent/src/iac/nodes.ts` (add the same 2 fields to `TURN_START_RESET`, currently ending at line 1553)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend the existing `describe("TURN_START_RESET (renovate-integration-update fields)", ...)` block — search the file for it; do not create a new describe block)

**Interfaces:**
- Produces: 2 new fields on `IacStateType`, consumed by Task 4 (`renovateTriggerGate` reads them into the interrupt payload).

```typescript
renovateRecentChanges: string;   // "" if KG disabled/empty/errored; set by enrichRenovateTarget
renovatePriorTriggers: string;   // "" if agent-memory backend not selected/no hits/errored
```

- [ ] **Step 1: Write the failing test**

First read the CURRENT full `TURN_START_RESET` test (it was extended twice already, by PR #666's own Task 3 and its review-fix rounds — confirm its exact current field count/name before writing this, since guessing the count wrong here has bitten this exact test twice before):

```bash
grep -n "TURN_START_RESET (renovate-integration-update fields)" -A 30 packages/agent/src/iac/renovate-integration.test.ts
```

Extend that existing test's expected object (do not duplicate the describe block) to include the 2 new fields at their reset values, and update the test's field-count assertion in its name/count to match the new total:

```typescript
// Inside the existing describe("TURN_START_RESET (renovate-integration-update fields)", ...)
// block, extend the existing test's expected object and rename it to reflect the new count
// (read the actual current test name/count first -- it was "11" after PR #666's Task 3; this
// task adds 2 more, making it 13 -- but VERIFY against the real current file, don't trust this
// comment's arithmetic blindly):
test("resets all 13 renovate-integration-update fields", () => {
	expect(TURN_START_RESET).toMatchObject({
		renovateTarget: null,
		renovateCandidates: [],
		renovateMarker: null,
		renovateTriggerApproved: null,
		renovateIssueIid: null,
		renovateMrUrl: "",
		renovateTriggerAtIso: "",
		renovateInstalledVersion: null,
		renovateTargetVersion: null,
		renovatePolicyCount: null,
		renovateChangelog: [],
		renovateRecentChanges: "",
		renovatePriorTriggers: "",
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: FAIL — `TURN_START_RESET` is missing the 2 new keys.

- [ ] **Step 3: Add the state fields**

In `packages/agent/src/iac/state.ts`, immediately after the `renovateChangelog` Annotation (after its closing `}),` — currently line 812), before the `// SIO-930` comment:

```typescript
	// SIO-XXXX: KG change-history + prior-trigger memory recall for this deployment/marker,
	// mirroring the fleet-upgrade gate card's own recallDeploymentKgChanges/recallPriorFleetUpgrades
	// reads (this sub-flow bypasses graphEnrichIac/memoryEnrichIac exactly like fleet-upgrade does).
	// Both best-effort -- "" when KG is disabled/empty or agent-memory isn't the selected backend.
	renovateRecentChanges: Annotation<string>({ reducer: last, default: () => "" }),
	renovatePriorTriggers: Annotation<string>({ reducer: last, default: () => "" }),
```

- [ ] **Step 4: Add the same 2 fields to `TURN_START_RESET`**

In `packages/agent/src/iac/nodes.ts`, immediately after `renovateChangelog: [] as ChangelogEntry[],` (currently line 1553), before the closing `} as const;`:

```typescript
	renovateRecentChanges: "",
	renovatePriorTriggers: "",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "TURN_START_RESET"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd packages/agent && bun run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: add renovateRecentChanges/renovatePriorTriggers state fields + TURN_START_RESET"
```

---

### Task 4: Surface both fields on the interrupt payload

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (`renovateTriggerGate`, currently lines 655-669)

**Interfaces:**
- Consumes: `state.renovateRecentChanges`, `state.renovatePriorTriggers` (Task 3).
- Produces: an extended interrupt payload — Task 5 updates the Zod schema, Task 6 updates the reducer/sse-pump.

- [ ] **Step 1: Write the failing test**

The existing `describe("renovateTriggerGate interrupt round-trip (SIO-1471)", ...)` block already has a test asserting the interrupt payload carries the 4 enrichment fields (added in PR #666's own Task 6 — search for `"interrupt payload carries the enrichment fields set by enrichRenovateTarget"`). Extend THAT SAME test (do not add a new one) to also assert the 2 new fields:

```typescript
// Inside the existing test "interrupt payload carries the enrichment fields set by
// enrichRenovateTarget" (in describe("renovateTriggerGate interrupt round-trip (SIO-1471)")),
// add to BOTH the inputState object and the toMatchObject assertion:
const inputState = {
	requestId: "req-1",
	renovateMarker: marker,
	renovateInstalledVersion: "2.8.0",
	renovateTargetVersion: "2.9.4",
	renovatePolicyCount: 24,
	renovateChangelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	renovateRecentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
	renovatePriorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
};

// ...

expect(interruptValue).toMatchObject({
	installedVersion: "2.8.0",
	targetVersion: "2.9.4",
	policyCount: 24,
	changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
	recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
	priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
});
```

Read the actual existing test first (grep for its exact name in `renovate-integration.test.ts`) and extend its real current structure — do not assume the surrounding code matches this snippet exactly; only the two new field additions are new content.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "carries the enrichment fields"`
Expected: FAIL — the interrupt payload is missing `recentChanges`/`priorTriggers`.

- [ ] **Step 3: Implement**

In `packages/agent/src/iac/nodes.ts`, update `renovateTriggerGate`'s `interrupt({...})` call (currently lines 658-669):

```typescript
	const choice = interrupt({
		type: "renovate_trigger_choice",
		marker: marker.marker,
		line: marker.line,
		message: buildRenovateGateMessage(marker),
		// SIO-XXXX: pre-trigger enrichment from enrichRenovateTarget -- best-effort, any/all may
		// be null/[]/"" when Kibana, the changelog fetch, KG, or agent-memory were unavailable.
		installedVersion: state.renovateInstalledVersion,
		targetVersion: state.renovateTargetVersion,
		policyCount: state.renovatePolicyCount,
		changelog: state.renovateChangelog,
		recentChanges: state.renovateRecentChanges,
		priorTriggers: state.renovatePriorTriggers,
	}) as { approve?: boolean };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: full file passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-XXXX: surface KG/memory recall on the renovate_trigger_choice interrupt payload"
```

---

### Task 5: Shared SSE event schema

**Files:**
- Modify: `packages/shared/src/agent-state.ts` (the `renovate_trigger_choice` object in `StreamEventSchema`, currently ending at line 1263)
- Test: `packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts` (extend the EXISTING file from PR #666 — do not create a new file; this file already tests this exact schema variant's other optional fields via `describe(...) + StreamEventSchema.safeParse(...)`)

**Interfaces:**
- Produces: `StreamEventSchema`'s `renovate_trigger_choice` variant gains 2 new optional string fields.

- [ ] **Step 1: Write the failing tests**

Read the existing `packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts` in full first (it's short, 4 tests from PR #666) and add 2 more tests matching its exact style:

```typescript
// Append inside the existing describe("StreamEventSchema renovate_trigger_choice enrichment
// fields", () => { ... }) block in agent-state.renovate-enrichment.test.ts, after its last
// existing test.
test("accepts recentChanges and priorTriggers when present", () => {
	const parsed = StreamEventSchema.safeParse({
		type: "renovate_trigger_choice",
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
		recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
		priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
	});
	expect(parsed.success).toBe(true);
	if (parsed.success && parsed.data.type === "renovate_trigger_choice") {
		expect(parsed.data.recentChanges).toContain("elastic_agent changed");
		expect(parsed.data.priorTriggers).toContain("Renovate update triggered");
	}
});

test("still accepts the event when recentChanges/priorTriggers are absent (older/degraded payload)", () => {
	const parsed = StreamEventSchema.safeParse({
		type: "renovate_trigger_choice",
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
	});
	expect(parsed.success).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: the FIRST new test fails on the data-presence assertions (`parsed.data.recentChanges`/`parsed.data.priorTriggers` are `undefined` because Zod's default `.strip()` behavior silently drops unrecognized keys — this is the SAME RED-state gotcha PR #666's Task 7 already hit once; the explicit data-presence check in this test is what makes the RED state real, not just `.success` alone).

- [ ] **Step 3: Update the schema**

In `packages/shared/src/agent-state.ts`, inside the `renovate_trigger_choice` object (currently ending at line 1263, right before the `.optional(),` that closes the `changelog` field's definition), add two more fields:

```typescript
		changelog: z
			.array(
				z.object({
					version: z.string(),
					changes: z.array(
						z.object({
							description: z.string(),
							type: z.string(),
							link: z.string().optional(),
						}),
					),
				}),
			)
			.optional(),
		// SIO-XXXX: KG change-history + prior-trigger memory recall, mirroring the fleet-upgrade
		// gate's recentChanges/priorUpgrades fields (this sub-flow's own twin of that same pattern).
		recentChanges: z.string().optional(),
		priorTriggers: z.string().optional(),
	}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && bun test src/__tests__/agent-state.renovate-enrichment.test.ts`
Expected: PASS, all 6 tests (4 existing + 2 new).

- [ ] **Step 5: Typecheck**

Run: `cd packages/shared && bun run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/agent-state.ts packages/shared/src/__tests__/agent-state.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: extend renovate_trigger_choice SSE schema with recentChanges/priorTriggers"
```

---

### Task 6: `sse-pump.ts` + `agent-reducer.ts` — thread both fields through to the store

**Files:**
- Modify: `apps/web/src/lib/server/sse-pump.ts` (the `renovate_trigger_choice` emit branch, currently lines 899-912; the `emitIacInterrupt` local `obj` type literal, currently lines 736-754)
- Modify: `apps/web/src/lib/stores/agent-reducer.ts` (the `RenovateTriggerChoice` interface, currently lines 312-321; the `renovate_trigger_choice` reducer case, currently lines 834-848)
- Test: `apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts` (extend the EXISTING file from PR #666 — do not create a new file)

**Interfaces:**
- Consumes: the raw SSE event object's `obj.recentChanges`/`obj.priorTriggers` (from Task 5's schema) in `sse-pump.ts`.
- Produces: `RenovateTriggerChoice` interface gains 2 new optional fields; the reducer case populates them.

**Important note on the `obj` type literal in `sse-pump.ts`:** `recentChanges?: unknown` is ALREADY declared in `emitIacInterrupt`'s local type literal (line 745, from the pre-existing SIO-1462 fleet-upgrade gate) — reuse it, do NOT declare it a second time (a duplicate-property TypeScript error, the exact gotcha PR #666's Task 8 already hit once for `targetVersion`). `priorTriggers?: unknown` does NOT already exist (the closest existing field, `priorUpgrades?: unknown` at line 744, is a DIFFERENT field for a different concept — fleet-upgrade facts, not renovate-trigger facts) — declare `priorTriggers?: unknown` as a new field.

- [ ] **Step 1: Write the failing tests**

Read the existing `apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts` in full first (it's short, from PR #666) and add 2 more tests matching its exact style:

```typescript
// Append inside the existing describe("applyStreamEvent renovate_trigger_choice enrichment
// fields", () => { ... }) block, after its last existing test.
test("populates recentChanges and priorTriggers when present", () => {
	const event = {
		type: "renovate_trigger_choice" as const,
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
		recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
		priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
	};
	const result = applyStreamEvent(initialReducerState(), event);
	expect(result.renovateTriggerChoice?.recentChanges).toContain("elastic_agent changed");
	expect(result.renovateTriggerChoice?.priorTriggers).toContain("Renovate update triggered");
});

test("tolerates missing recentChanges/priorTriggers (older/degraded payload)", () => {
	const event = {
		type: "renovate_trigger_choice" as const,
		threadId: "t1",
		marker: "x",
		line: "y",
		message: "z",
	};
	const result = applyStreamEvent(initialReducerState(), event);
	expect(result.renovateTriggerChoice?.recentChanges).toBeUndefined();
	expect(result.renovateTriggerChoice?.priorTriggers).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bun run test src/lib/stores/agent-reducer.renovate-enrichment.test.ts`
Expected: FAIL — `result.renovateTriggerChoice?.recentChanges`/`priorTriggers` are `undefined` in the first new test (the reducer doesn't populate them yet).

- [ ] **Step 3: Update `RenovateTriggerChoice`**

In `apps/web/src/lib/stores/agent-reducer.ts`, extend the interface (currently lines 312-321):

```typescript
export interface RenovateTriggerChoice {
	threadId: string;
	marker: string;
	line: string;
	message: string;
	installedVersion?: string | null;
	targetVersion?: string | null;
	policyCount?: number | null;
	changelog?: Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>;
	// SIO-XXXX: KG change-history + prior-trigger memory recall, mirroring FleetUpgradeChoice's
	// own recentChanges/priorUpgrades fields.
	recentChanges?: string;
	priorTriggers?: string;
}
```

- [ ] **Step 4: Update the reducer case**

In `apps/web/src/lib/stores/agent-reducer.ts`, extend the `renovate_trigger_choice` case (currently lines 834-848):

```typescript
		case "renovate_trigger_choice":
			return {
				...state,
				threadId: event.threadId,
				renovateTriggerChoice: {
					threadId: event.threadId,
					marker: event.marker,
					line: event.line,
					message: event.message,
					installedVersion: event.installedVersion,
					targetVersion: event.targetVersion,
					policyCount: event.policyCount,
					changelog: event.changelog,
					recentChanges: event.recentChanges,
					priorTriggers: event.priorTriggers,
				},
			};
```

- [ ] **Step 5: Update `sse-pump.ts`'s `obj` type literal and emit branch**

In `apps/web/src/lib/server/sse-pump.ts`, add ONLY `priorTriggers?: unknown;` to the local type literal (immediately after the existing `changelog?: unknown;` at line 753 — `recentChanges?: unknown` already exists at line 745, do not re-declare it):

```typescript
		installedVersion?: unknown;
		policyCount?: unknown;
		changelog?: unknown;
		priorTriggers?: unknown;
	};
```

Then update the `renovate_trigger_choice` emit branch (currently lines 899-912):

```typescript
	if (obj.type === "renovate_trigger_choice") {
		send({
			type: "renovate_trigger_choice",
			threadId,
			marker: typeof obj.marker === "string" ? obj.marker : "",
			line: typeof obj.line === "string" ? obj.line : "",
			message: typeof obj.message === "string" ? obj.message : "Trigger this Renovate update?",
			...(typeof obj.installedVersion === "string" && { installedVersion: obj.installedVersion }),
			...(typeof obj.targetVersion === "string" && { targetVersion: obj.targetVersion }),
			...(typeof obj.policyCount === "number" && { policyCount: obj.policyCount }),
			...(Array.isArray(obj.changelog) && obj.changelog.length > 0 && { changelog: obj.changelog }),
			...(typeof obj.recentChanges === "string" && obj.recentChanges && { recentChanges: obj.recentChanges }),
			...(typeof obj.priorTriggers === "string" && obj.priorTriggers && { priorTriggers: obj.priorTriggers }),
		});
		return true;
	}
```
Note the extra truthiness check (`&& obj.recentChanges`) on top of the `typeof === "string"` check for these two fields specifically — both recall functions can return `""` (not just omit the field), and an empty string should NOT populate the field (matching `FleetUpgradeChoiceCard`'s own `{#if prompt.recentChanges}` gate, which treats `""` as absent/falsy — sending `recentChanges: ""` over the wire would make the card's `{#if}` check still correctly hide the panel since `""` is falsy in Svelte too, but omitting the key entirely is more consistent with how `changelog`'s own `.length > 0` guard already avoids sending an empty-but-present array).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/web && bun run test && bun run typecheck`
Expected: all pass, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/server/sse-pump.ts apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/stores/agent-reducer.renovate-enrichment.test.ts
git commit -m "SIO-XXXX: thread recentChanges/priorTriggers through sse-pump and the reducer"
```

---

### Task 7: `RenovateTriggerChoiceCard.svelte` — render the two recall panels

**Files:**
- Modify: `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte`

**Interfaces:**
- Consumes: `prompt.recentChanges`, `prompt.priorTriggers` (Task 6).
- Produces: no new interface — leaf UI consumer.

- [ ] **Step 1: Implement**

Add the `MarkdownRenderer` import (copy `FleetUpgradeChoiceCard.svelte`'s own import line exactly) and insert two new `<details open>` panels between the stat-tile grid and the changelog `<details>` block (matching `FleetUpgradeChoiceCard`'s panel ordering: KG panel, then memory panel, then the rest of the card).

Update the `<script>` block's imports (currently just line 3):
```svelte
<script lang="ts">
// apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
import type { RenovateTriggerChoice } from "$lib/stores/agent-reducer.ts";
```

Insert after the closing `{/if}` of the `hasStats` stat-tile grid block (currently ending at line 52), before the `{#if changelogCount > 0}` block (currently starting at line 54):

```svelte
    <!-- SIO-XXXX: knowledge-graph change history for this deployment, mirroring
         FleetUpgradeChoiceCard's own "Recent changes (knowledge graph)" panel -- the
         renovate-integration-update lane also bypasses graphEnrichIac, so enrichRenovateTarget
         reads the KG itself via the same recallDeploymentKgChanges function fleet-upgrade uses.
         Gated on presence -- an off/empty KG yields "" and the panel stays hidden. -->
    {#if prompt.recentChanges}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Recent changes (knowledge graph)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.recentChanges} />
        </div>
      </details>
    {/if}

    <!-- SIO-XXXX: cross-session agent-memory recall of prior Renovate triggers for this exact
         deployment+integration pair, so the operator sees "we've triggered this before" (and its
         MR, if one was found) before approving -- the renovate-path twin of
         FleetUpgradeChoiceCard's "Prior upgrades (memory)" block. -->
    {#if prompt.priorTriggers}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Prior triggers (memory)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.priorTriggers} />
        </div>
      </details>
    {/if}

```

- [ ] **Step 2: Verify with the Svelte MCP tools**

Per this repo's CLAUDE.md, `.svelte` file edits should be validated via the `svelte:svelte-code-writer` skill / Svelte MCP server tools (`mcp__plugin_svelte_svelte__svelte-autofixer` or equivalent) before considering the file done. Run the autofixer/validator against this file and fix any reported issues.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
git commit -m "SIO-XXXX: render KG change-history + prior-trigger memory panels on the Renovate card"
```

---

### Task 8: Live end-to-end verification

**Files:** none (verification only — no code changes)

**Interfaces:** none.

- [ ] **Step 1: Start the web app**

Check the port first: `lsof -i :5173` (or pick a free port if occupied by another session's dev server, per this repo's documented worktree-port convention — do NOT kill a server you didn't start). Start it: `bun --env-file=<absolute-path-to-main-repo's .env> run dev -- --port <PORT>` from `apps/web` in this task's worktree (a fresh worktree carries no `.env` — this is a known, documented gotcha in this repo; use the ABSOLUTE path to the main checkout's `.env`, not a relative one).

- [ ] **Step 2: Confirm the KG panel's expected state honestly**

Check whether `KNOWLEDGE_GRAPH_ENABLED=true` is set in the sourced `.env`. If it is NOT set, the "Recent changes (knowledge graph)" panel is expected to stay hidden for every test in this task (this matches `recallDeploymentKgChanges`'s own documented behavior — gated on the flag, soft-fails to `""` when off) — do not treat a hidden KG panel as a bug in that case. If it IS set, proceed to look for a deployment with real prior `ConfigChange` KG data to confirm the panel populates.

- [ ] **Step 3: Trigger a renovate-integration-update turn for a deployment/integration pair NOT triggered before**

Ask the elastic-iac agent to update a deployment/integration pair known to have a pending Dependency Dashboard entry (check via `gh api`/GitLab UI for a currently-unticked entry first, since prior sessions' live tests may have already merged the obvious candidates). Confirm the card shows: the existing installed/target/policy-count stats and changelog (unchanged from PR #666), PLUS confirm the "Prior triggers (memory)" panel is ABSENT (since this is the first-ever trigger for this exact deployment+marker pair — nothing to recall yet). Decline the trigger (do not fire a real Renovate run for this verification step).

- [ ] **Step 4: Trigger the SAME deployment/integration pair a second time**

This requires either (a) a deployment+integration pair that was ALREADY triggered in a prior session (check `docs/superpowers/plans/2026-08-15-renovate-integration-update-intent.md`'s or PR #663/#666's live-verification notes for a pair with a durable fact already written — e.g. `ap-cld`/`elastic_agent` if the earlier "in the ap-cld deployment, upgrade the elastic_agent integration" screenshot the user showed already produced a durable fact via `teardownIac`), or (b) actually approve Task 8 Step 3's trigger (a real, live Renovate run) and wait for `watchRenovateMr` to find the resulting MR, so `teardownIac` writes the durable fact, THEN re-trigger the same pair a third time to see the recall. Prefer (a) if a prior fact already exists — it's faster and avoids firing an unnecessary extra live Renovate run. Confirm the card's "Prior triggers (memory)" panel is now PRESENT and references the correct prior MR URL.

- [ ] **Step 5: Kill the dev server**

Track the PID from Step 1 and kill it; verify with `lsof -nP -iTCP:<PORT> -sTCP:LISTEN` that nothing remains listening.

- [ ] **Step 6: Final full-suite verification**

Run from repo root: `bun run typecheck && bun run lint && bun run test`
Expected: all packages 0 typecheck errors; lint clean on every file this plan touched (pre-existing unrelated warnings elsewhere are not in scope); all tests pass.

- [ ] **Step 7: No commit for this task** (verification only)
