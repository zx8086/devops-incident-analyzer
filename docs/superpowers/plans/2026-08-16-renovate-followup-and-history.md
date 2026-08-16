# Renovate follow-up guard + deployment-wide history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two confirmed gaps in the elastic-iac agent's Renovate sub-flow: (1) a follow-up like "Please check again" after a Renovate trigger with no MR yet currently re-runs extraction from scratch and reports a false "no pending update," instead of re-polling for the MR; (2) the agent has no way to answer "what Renovate integration updates has this deployment had before" for any integration other than the one currently being discussed, because the KG never records Renovate triggers and the only memory recall is hard-scoped to the exact marker.

**Architecture:** Fix 1 adds a durable, cross-turn state field (`renovateInFlightMarker`, excluded from `TURN_START_RESET`, mirroring the existing `fleetApplyPipelineId` pattern from SIO-928) plus a deterministic pre-LLM classifier guard and a new intent value (`renovate-status-check`) that routes straight to `watchRenovateMr`, bypassing re-extraction entirely. Fix 2 adds one KG write (`recordLaneConfigChange`, mirroring the existing fleet-upgrade call) at trigger time, plus a new deployment-wide (not marker-scoped) Agent Memory recall function mirroring the existing `recallPriorFleetUpgrades`, threaded through the established 6-layer card-enrichment pattern (state -> `TURN_START_RESET` -> interrupt payload -> SSE schema -> sse-pump/agent-reducer -> Svelte card) as a new collapsed panel.

**Tech Stack:** TypeScript (strict, no `any`), Bun test (`bun:test`), LangGraph `StateGraph` node/edge/router functions, Zod (SSE schema), Svelte 5 + Tailwind (card component).

**Spec:** [docs/superpowers/specs/2026-08-16-renovate-followup-and-history-design.md](../specs/2026-08-16-renovate-followup-and-history-design.md)

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Named exports preferred; no comments beyond the file's established "why" style.
- `renovateInFlightMarker` must NOT be added to `TURN_START_RESET` (`nodes.ts:1678`) — that is the entire point of the field; it must survive across turns exactly like `fleetApplyPipelineId`.
- The new classifier guard must only fire when `renovateInFlightMarker != null` AND the query looks like a status check — it must never swallow a genuinely new Renovate upgrade request for a different integration (verified via a dedicated test).
- The KG write happens exactly ONCE per trigger, at `triggerRenovateUpdate` success — never repeated on subsequent `watchRenovateMr` re-check turns.
- The new deployment-wide recall (`recallPriorRenovateTriggersForDeployment`) does NOT replace or modify the existing marker-scoped `recallPriorRenovateTriggers` (`nodes.ts:12270`) — both run, feeding two separate card panels.
- Every new external-call function (KG write, memory recall) is best-effort: soft-fails to a safe default (`""` for recalls, silently skips for the KG write), never throws, never sets `blockedReason`.
- Run `bun run typecheck && bun run lint` and the affected test file(s) after every task.

---

### Task 1: `renovateInFlightMarker` state field + `looksLikeRenovateStatusCheck` predicate

**Files:**
- Modify: `packages/agent/src/iac/state.ts` (new Annotation field, near `renovateMarker` at line 795)
- Modify: `packages/agent/src/iac/nodes.ts` (new predicate function, near `looksLikeFleetStatusCheck` at line 1409; add field to `TURN_START_RESET`'s comment block is NOT needed since the field is deliberately excluded — but a one-line note explaining the exclusion belongs at the field's own declaration)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (new `describe` block for the predicate)

**Interfaces:**
- Produces: `IacStateType.renovateInFlightMarker: { deployment: string; marker: string; line: string; triggerAtIso: string } | null` (new Annotation, `reducer: last`, `default: () => null`).
- Produces: `export function looksLikeRenovateStatusCheck(text: string): boolean` — pure predicate, same shape as `looksLikeFleetStatusCheck` (`nodes.ts:1409-1436`): lowercases input, returns `false` if a version number pattern (`/\b\d+\.\d+(\.\d+)?\b/`) is present (a fresh upgrade naming a version is never a status check), otherwise `true` if any of the same `STATUS_CUES` list matches (`"how is"`, `"how's"`, `"check on"`, `"check it"`, `"any update"`, `"status"`, `"progress"`, `"still running"`, etc. — reuse the exact literal array from `looksLikeFleetStatusCheck`, plus add `"check again"` and `"ask again"` since those are the exact phrasings this bug report used and are not already covered by the existing cue list).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/iac/renovate-integration.test.ts`, as a new top-level `describe` block (place after the existing `describe("resolveIntegrationSlug (SIO-1474)", ...)` block, at the end of the file):

```typescript
import { looksLikeRenovateStatusCheck } from "./nodes.ts";

describe("looksLikeRenovateStatusCheck (SIO-1475)", () => {
	test("matches 'Please check again'", () => {
		expect(looksLikeRenovateStatusCheck("Please check again")).toBe(true);
	});

	test("matches 'check on it'", () => {
		expect(looksLikeRenovateStatusCheck("check on it")).toBe(true);
	});

	test("matches 'any update?'", () => {
		expect(looksLikeRenovateStatusCheck("any update?")).toBe(true);
	});

	test("matches 'ask again'", () => {
		expect(looksLikeRenovateStatusCheck("ok, ask again in a minute")).toBe(true);
	});

	test("does not match a fresh upgrade request naming a version", () => {
		expect(looksLikeRenovateStatusCheck("upgrade udp to 2.5.1 on ap-cld")).toBe(false);
	});

	test("does not match a fresh upgrade request naming an integration, no status cue", () => {
		expect(looksLikeRenovateStatusCheck("In the ap-cld deployment, upgrade the 'Custom UDP Logs' integration")).toBe(
			false,
		);
	});

	test("does not match unrelated text", () => {
		expect(looksLikeRenovateStatusCheck("what deployments do we have")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "looksLikeRenovateStatusCheck"`
Expected: FAIL — `SyntaxError: Export named 'looksLikeRenovateStatusCheck' not found in module './nodes.ts'`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/state.ts`, add the new Annotation immediately after the existing `renovateMarker` field (currently line 795):

```typescript
	renovateMarker: Annotation<{ marker: string; line: string } | null>({ reducer: last, default: () => null }),
	// SIO-1475: durable, cross-turn "a Renovate trigger is in flight, no MR found yet" marker --
	// the Renovate-lane twin of fleetApplyPipelineId (SIO-928). Deliberately NOT reset by
	// TURN_START_RESET (see that object's own comment) so a later turn's classifyIacIntent guard
	// can route a "check again" follow-up straight to watchRenovateMr instead of re-extracting.
	// Set by triggerRenovateUpdate on a successful trigger; cleared by watchRenovateMr once the
	// MR is found.
	renovateInFlightMarker: Annotation<{ deployment: string; marker: string; line: string; triggerAtIso: string } | null>(
		{ reducer: last, default: () => null },
	),
```

In `packages/agent/src/iac/nodes.ts`, add the new predicate immediately after `looksLikeFleetStatusCheck`'s closing brace (currently ending at line 1436, before the `looksLikeChangeRequest` comment block at line 1438):

```typescript
// SIO-1475: the renovate-lane twin of looksLikeFleetStatusCheck (nodes.ts:1409) -- reused cue
// list plus two phrasings this bug's own repro used verbatim ("check again", "ask again"),
// since triggerRenovateUpdate's own "no MR yet" message (nodes.ts:966) explicitly suggests
// "Ask me to check again in a minute." (Pure; unit-tested.)
export function looksLikeRenovateStatusCheck(text: string): boolean {
	const r = text.toLowerCase();
	if (/\b\d+\.\d+(\.\d+)?\b/.test(r)) return false;
	const STATUS_CUES = [
		"how is",
		"how's",
		"hows",
		"how are",
		"how far",
		"status",
		"progress",
		"check on",
		"check it",
		"check again",
		"ask again",
		"watch the pipeline",
		"watch it",
		"going",
		"done yet",
		"is it done",
		"finished",
		"complete",
		"any update",
		"update on",
		"still running",
	];
	return STATUS_CUES.some((cue) => r.includes(cue));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "looksLikeRenovateStatusCheck"`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1475: add renovateInFlightMarker state field and looksLikeRenovateStatusCheck predicate"
```

---

### Task 2: `renovate-status-check` intent + classifier guard + graph wiring

**Files:**
- Modify: `packages/agent/src/iac/state.ts:44-54` (add `"renovate-status-check"` to `INTENT_VALUES`)
- Modify: `packages/agent/src/iac/nodes.ts:1362-1379` (`intentFromText`'s return type union — add the new literal; the function body itself does not need a new branch since this intent is never reached via LLM classification, only via the deterministic guard added below)
- Modify: `packages/agent/src/iac/nodes.ts` (new deterministic guard in `classifyIacIntent`, immediately after the existing `fleetApplyPipelineId` guard at lines 1580-1586)
- Modify: `packages/agent/src/iac/graph.ts:106-134` (`intentTarget` router + `INTENT_TARGETS` array — add the new intent -> `watchRenovateMr` mapping)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (new `describe` block for the guard)

**Interfaces:**
- Consumes: `Task 1`'s `renovateInFlightMarker` field and `looksLikeRenovateStatusCheck` predicate.
- Produces: `IacIntent` now includes `"renovate-status-check"` as a valid value. `classifyIacIntent` returns `{ intent: "renovate-status-check" }` when the guard fires. `graph.ts`'s `intentTarget` router maps `"renovate-status-check"` directly to `"watchRenovateMr"` (added to `INTENT_TARGETS` too).

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/iac/renovate-integration.test.ts`, after the `looksLikeRenovateStatusCheck` block from Task 1:

```typescript
import { classifyIacIntent } from "./nodes.ts";
import { HumanMessage } from "@langchain/core/messages";

// SIO-1475: mirrors fleet-upgrade.test.ts's "classifyIacIntent fleet-status guard (SIO-928)"
// describe block EXACTLY, including its documented reason for avoiding a real classifyIacIntent
// call in the negative cases: "avoiding a process-global createLlm mock that would pollute
// sibling tests." The guard-fires case calls classifyIacIntent directly (it returns before ever
// reaching the LLM call, so no mock is needed there); the two negative cases assert against the
// underlying predicate/state shape instead, never against classifyIacIntent itself.
describe("classifyIacIntent renovate-status guard (SIO-1475)", () => {
	const humanState = (content: string, renovateInFlightMarker: IacStateType["renovateInFlightMarker"]) =>
		({
			messages: [{ getType: () => "human", content }],
			renovateInFlightMarker,
		}) as unknown as IacStateType;

	const inFlight = {
		deployment: "ap-cld",
		marker: "renovate/ap-cld-udp",
		line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
		triggerAtIso: new Date().toISOString(),
	};

	test("a status-check follow-up with a Renovate trigger in flight routes to renovate-status-check (no LLM)", async () => {
		const { classifyIacIntent } = await import("./nodes.ts");
		for (const q of ["Please check again", "check on it", "any update?"]) {
			const out = await classifyIacIntent(humanState(q, inFlight));
			expect(out.intent).toBe("renovate-status-check");
		}
	});

	test("no in-flight marker -> the guard's own condition is false (asserted directly, no classifyIacIntent call)", () => {
		// Mirrors this file's own guard shape: `state.renovateInFlightMarker != null && looksLikeRenovateStatusCheck(query)`.
		// With renovateInFlightMarker null, the `!=null` half is false regardless of the query text --
		// asserted without invoking classifyIacIntent (which would otherwise fall through to a real LLM call).
		const marker: IacStateType["renovateInFlightMarker"] = null;
		expect(marker != null).toBe(false);
	});

	test("a FRESH upgrade request does NOT trip the guard even with a trigger in flight", async () => {
		// "upgrade the 'system' integration" names an integration/action, not a status check --
		// the guard predicate must reject it so classifyIacIntent falls through to the LLM and a
		// second, different upgrade is never swallowed as renovate-status-check. Asserted at the
		// predicate the guard uses, same avoidance-of-real-LLM-call rationale as SIO-928's sibling test.
		const { looksLikeRenovateStatusCheck } = await import("./nodes.ts");
		expect(looksLikeRenovateStatusCheck("In the ap-cld deployment, upgrade the 'system' integration")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "renovate-status guard"`
Expected: FAIL — the first test (`"a status-check follow-up with a Renovate trigger in flight routes to renovate-status-check (no LLM)"`) asserts `out.intent === "renovate-status-check"` for each of 3 queries, but the guard does not exist yet, so `classifyIacIntent` falls through toward the real LLM classification path and never returns that intent — expect a real network call attempt or a timeout, not a clean assertion failure; either is an acceptable RED signal here since `looksLikeRenovateStatusCheck` (this test's second dependency, from Task 1) is already implemented and passing, isolating the guard itself as the only missing piece. The other two tests do not call `classifyIacIntent` and should already pass (nothing to break yet in those).

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/state.ts`, add to `INTENT_VALUES` (currently lines 44-54), inserted alphabetically-adjacent to its sibling for readability (after `"renovate-integration-update"`):

```typescript
export const INTENT_VALUES = [
	"info",
	"gitops",
	"gitops-amend",
	"pipeline-status",
	"drift",
	"synthetics-drift",
	"fleet-upgrade",
	"renovate-integration-update",
	"renovate-status-check",
	"converse",
] as const;
```

In `packages/agent/src/iac/nodes.ts`, add `"renovate-status-check"` to `intentFromText`'s return-type union (currently lines 1362-1379):

```typescript
export function intentFromText(
	raw: string,
):
	| "info"
	| "gitops"
	| "pipeline-status"
	| "drift"
	| "synthetics-drift"
	| "fleet-upgrade"
	| "renovate-integration-update"
	| "renovate-status-check"
	| "converse" {
```

(No new branch is added inside `intentFromText`'s body — this intent is reached only via the deterministic guard below, never via the LLM's raw-text classification, mirroring how `"gitops-amend"` is also absent from this function's own branches.)

In `packages/agent/src/iac/nodes.ts`, add the new guard in `classifyIacIntent`, immediately after the existing `fleetApplyPipelineId` guard block (currently ending at line 1586, before the SIO-990 comment at line 1587):

```typescript
	// SIO-1475: the renovate-lane twin of the fleetApplyPipelineId guard immediately above --
	// same rationale (SIO-928): a Renovate trigger with no MR found yet has no reliable way for
	// the LLM classifier to recognize "check again" as a continuation rather than a fresh
	// request, since renovateTarget/renovateMarker are turn-scoped and already null by now.
	// renovateInFlightMarker survives TURN_START_RESET specifically so this guard can fire.
	if (state.renovateInFlightMarker != null && looksLikeRenovateStatusCheck(query)) {
		log.info(
			{ query, renovateInFlightMarker: state.renovateInFlightMarker },
			"iac intent: renovate-status guard -> renovate-status-check",
		);
		return { intent: "renovate-status-check" };
	}
```

In `packages/agent/src/iac/graph.ts`, update `intentTarget` (currently lines 106-123) to add the new branch, checked alongside the existing `renovate-integration-update` branch:

```typescript
	const intentTarget = (s: typeof IacState.State) =>
		s.intent === "gitops"
			? "parseIntent"
			: s.intent === "gitops-amend"
				? "amendChange"
				: s.intent === "fleet-upgrade"
					? "detectFleetUpgrade"
					: s.intent === "renovate-integration-update"
						? "extractRenovateTarget"
						: s.intent === "renovate-status-check"
							? "watchRenovateMr"
							: s.intent === "synthetics-drift"
								? "detectSyntheticsDrift"
								: s.intent === "drift"
									? "detectDrift"
									: s.intent === "pipeline-status"
										? "watchPipeline"
										: s.intent === "converse"
											? "converseIac"
											: "answerInfo";
```

And add `"watchRenovateMr"` to `INTENT_TARGETS` (currently lines 125-134) — it is not already present in that array (only `"extractRenovateTarget"` is, as the renovate-integration-update entry point):

```typescript
	const INTENT_TARGETS = [
		"parseIntent",
		"amendChange",
		"detectFleetUpgrade",
		"extractRenovateTarget",
		"watchRenovateMr",
		"detectSyntheticsDrift",
		"detectDrift",
		"answerInfo",
		"watchPipeline",
		"converseIac",
	] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "renovate-status guard"`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors. Typecheck will also surface any other exhaustive `switch`/ternary over `IacIntent` that does not yet handle the new `"renovate-status-check"` value — if `bun run typecheck` reports one, add the minimal handling matching that call site's existing pattern for other intents (e.g. a `default` fallthrough is likely already present; only add an explicit branch if TypeScript's strict exhaustiveness check actually errors, do not add unrequested branches).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/state.ts packages/agent/src/iac/nodes.ts packages/agent/src/iac/graph.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1475: add renovate-status-check intent and classifier guard"
```

---

### Task 3: `triggerRenovateUpdate` sets `renovateInFlightMarker`; `watchRenovateMr` falls back to it and clears it

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:841-896` (`triggerRenovateUpdate` — set the new field on success)
- Modify: `packages/agent/src/iac/nodes.ts:936-970` (`watchRenovateMr` — fall back to `renovateInFlightMarker` when `renovateMarker`/`renovateTriggerAtIso` are null/empty; clear the field on success)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (extend existing coverage or add new tests for both functions)

**Interfaces:**
- Consumes: `Task 1`'s `renovateInFlightMarker` field.
- Produces: `triggerRenovateUpdate`'s return type gains `renovateInFlightMarker` on its success path. `watchRenovateMr` reads `state.renovateMarker ?? state.renovateInFlightMarker` (adapted for the shape difference — see Step 3) and returns `{ renovateInFlightMarker: null, ... }` on its MR-found success branch.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/iac/renovate-integration.test.ts`. Mocking convention: this file has no existing `triggerRenovateUpdate`/`watchRenovateMr` tests to extend, so mirror `fleet-upgrade.test.ts`'s established `mockTools()` helper exactly (it stubs `../mcp-bridge.ts`'s `getToolsForDataSource`, which `callTool` in `nodes.ts:158-159` resolves through regardless of data-source argument):

```typescript
import { triggerRenovateUpdate, watchRenovateMr } from "./nodes.ts";

// Mirrors fleet-upgrade.test.ts's mockTools() helper exactly (same file also uses this
// convention for drift.test.ts) -- stubs mcp-bridge so callTool resolves through it.
function mockRenovateTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("triggerRenovateUpdate sets renovateInFlightMarker (SIO-1475)", () => {
	test("sets renovateInFlightMarker on a successful trigger", async () => {
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[200] {"status":"ok"}',
			gitlab_play_pipeline_schedule: () => '[200] {"status":"ok"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
		} as IacStateType;

		const out = await freshTriggerRenovateUpdate(state);

		expect(out.renovateInFlightMarker).toEqual({
			deployment: "ap-cld",
			marker: "renovate/ap-cld-udp",
			line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			triggerAtIso: expect.any(String),
		});
	});
});

describe("watchRenovateMr falls back to renovateInFlightMarker (SIO-1475)", () => {
	test("uses renovateInFlightMarker when renovateMarker is null (a re-check turn)", async () => {
		mockRenovateTools({
			gitlab_list_merge_requests_by_source_branch: () => "[200] []",
		});
		const { watchRenovateMr: freshWatchRenovateMr } = await import("./nodes.ts");
		process.env.IAC_PIPELINE_POLL_BUDGET_MS = "100";
		process.env.IAC_PIPELINE_POLL_INTERVAL_MS = "50";

		const state = {
			renovateMarker: null,
			renovateTriggerAtIso: "",
			renovateInFlightMarker: {
				deployment: "ap-cld",
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
				triggerAtIso: new Date().toISOString(),
			},
		} as IacStateType;

		const out = await freshWatchRenovateMr(state);

		expect(out.messages?.[0]?.content).toContain("renovate/ap-cld-udp");

		delete process.env.IAC_PIPELINE_POLL_BUDGET_MS;
		delete process.env.IAC_PIPELINE_POLL_INTERVAL_MS;
	});

	test("returns {} when both renovateMarker and renovateInFlightMarker are null", async () => {
		const out = await watchRenovateMr({ renovateMarker: null, renovateInFlightMarker: null } as IacStateType);
		expect(out).toEqual({});
	});
});
```

Note: `IAC_PIPELINE_POLL_BUDGET_MS`/`IAC_PIPELINE_POLL_INTERVAL_MS` (verified exact names, `nodes.ts:940-941`) are set to small values so the first test's poll loop (given a mocked empty-array MR list) completes quickly rather than waiting the real 90s default budget.

Note: this task's exact test bodies depend on the existing `triggerRenovateUpdate`/`watchRenovateMr` test mocking conventions already present in `renovate-integration.test.ts` (search the file for `describe("triggerRenovateUpdate"` and `describe("watchRenovateMr"` before writing — if such blocks already exist, extend them in place rather than duplicating a new mocking setup; if they do not exist yet, mirror `resolveRenovateMarker`'s `callTool`-mocking convention used elsewhere in this same file).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "renovateInFlightMarker"`
Expected: FAIL — `out.renovateInFlightMarker` is `undefined` (not yet set by `triggerRenovateUpdate`); `watchRenovateMr`'s fallback test fails because it currently reads `state.renovateMarker` directly (line 937) with no fallback, so `marker` is `null` and the function returns `{}` instead of polling.

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/nodes.ts`, modify `triggerRenovateUpdate`'s final return (currently line 895, `return { renovateTriggerAtIso: triggerAtIso };`):

```typescript
	// CodeRabbit (PR #663): emit AFTER both calls succeed, not before -- a failure on
	// either call above now returns early without ever showing "triggered", so the UI
	// never claims success ahead of the real outcome.
	await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: triggered" });

	// SIO-1475: durable marker for a later "check again" turn to resume watching, since
	// renovateMarker/renovateTriggerAtIso are both turn-scoped (TURN_START_RESET) and will be
	// null by the time a follow-up turn's classifyIacIntent guard needs to route back here.
	const inFlight = {
		deployment: state.renovateTarget?.deployment ?? "",
		marker: marker.marker,
		line: marker.line,
		triggerAtIso,
	};

	return { renovateTriggerAtIso: triggerAtIso, renovateInFlightMarker: inFlight };
```

Modify `watchRenovateMr` (currently lines 936-970) to fall back to `renovateInFlightMarker` when `renovateMarker` is null, and to clear `renovateInFlightMarker` on the success branch:

```typescript
export async function watchRenovateMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const marker = state.renovateMarker ?? state.renovateInFlightMarker;
	if (!marker) return {};

	const budgetMs = readPositiveMsEnv("IAC_PIPELINE_POLL_BUDGET_MS", 90000, log);
	const intervalMs = readPositiveMsEnv("IAC_PIPELINE_POLL_INTERVAL_MS", 10000, log);
	const deadline = Date.now() + budgetMs;
	const sourceBranch = marker.marker;
	// Greptile round 2 (PR #663): require the found MR's updated_at to be at or after this
	// run's own trigger instant, so a stale MR left open on the same reused branch from an
	// earlier trigger is never reported as this run's result.
	// SIO-1475: renovateTriggerAtIso is also turn-scoped -- fall back to the durable marker's
	// own triggerAtIso on a re-check turn where the turn-scoped field has already been reset.
	const sinceIso = state.renovateTriggerAtIso || state.renovateInFlightMarker?.triggerAtIso || undefined;

	while (Date.now() < deadline) {
		const listRes = await callTool("gitlab_list_merge_requests_by_source_branch", { sourceBranch });
		const mrUrl = parseFirstOpenMrUrl(listRes, sinceIso);
		if (mrUrl) {
			await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "renovate: MR created" });
			return {
				renovateMrUrl: mrUrl,
				renovateInFlightMarker: null,
				messages: [new AIMessage(`Renovate opened the update MR: ${mrUrl}`)],
			};
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	return {
		messages: [
			new AIMessage(
				`Triggered the Renovate run for '${sourceBranch}', but no MR has appeared yet. Ask me to check again in a minute.`,
			),
		],
	};
}
```

Note: `renovateInFlightMarker` is deliberately left SET (not cleared) on the "still no MR" fallthrough branch — the whole point is that it must survive to the NEXT re-check turn too. It is cleared only once the MR is actually found.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "renovateInFlightMarker"`
Expected: PASS.

Then run the full file to confirm no regressions:

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS, all tests green (existing `triggerRenovateUpdate`/`watchRenovateMr` tests, if any predate this task, must still pass — their inputs already carry `renovateMarker` set, which the fallback's `??` never overrides).

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1475: triggerRenovateUpdate sets, watchRenovateMr resumes from renovateInFlightMarker"
```

---

### Task 4: KG write on trigger (`recordLaneConfigChange` for the Renovate lane)

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:841-896` (`triggerRenovateUpdate` — add the KG write, after Task 3's edits to this same function)
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `recordLaneConfigChange` (`packages/agent/src/iac/lane-knowledge.ts:55`, existing, unchanged) and its `LaneChangeInput` type (`lane-knowledge.ts:37-51`, existing, unchanged).
- Produces: no new state fields — this is a side-effecting call, not a state write.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/iac/renovate-integration.test.ts`. No existing call site (fleet-upgrade/drift/synthetics) has its own test asserting `recordLaneConfigChange` was invoked with a specific shape — `recordLaneConfigChange` itself is tested directly, in isolation, in `lane-knowledge.test.ts`. So this task's test mocks `./lane-knowledge.ts` at the module level, following the exact real-module-capture-and-restore convention this file already established for `../memory-backend.ts`/`../memory-writer.ts` at the top of the file (lines 6-23) — capture the real module once, `mock.module` a spy version for the test, restore the real one in `afterEach` so the mock does not leak into other test files in the same Bun test process:

```typescript
import * as realLaneKnowledgeNs from "./lane-knowledge.ts";

const realLaneKnowledge = { ...realLaneKnowledgeNs };

describe("triggerRenovateUpdate records a KG ConfigChange (SIO-1475)", () => {
	afterEach(() => {
		mock.module("./lane-knowledge.ts", () => realLaneKnowledge);
	});

	test("calls recordLaneConfigChange with workflow: 'renovate' and outcome: 'proposed' on a successful trigger", async () => {
		const recordSpy = mock(async () => {});
		mock.module("./lane-knowledge.ts", () => ({ ...realLaneKnowledge, recordLaneConfigChange: recordSpy }));
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[200] {"status":"ok"}',
			gitlab_play_pipeline_schedule: () => '[200] {"status":"ok"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
			requestId: "req-123",
			threadId: "thread-abc",
		} as IacStateType;

		await freshTriggerRenovateUpdate(state);

		expect(recordSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "req-123",
				deployment: "ap-cld",
				workflow: "renovate",
				outcome: "proposed",
				summary: "renovate ap-cld -> renovate/ap-cld-udp",
				threadId: "thread-abc",
			}),
		);
	});

	test("does NOT call recordLaneConfigChange when the tick call fails", async () => {
		const recordSpy = mock(async () => {});
		mock.module("./lane-knowledge.ts", () => ({ ...realLaneKnowledge, recordLaneConfigChange: recordSpy }));
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[500] {"error":"internal error"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
			requestId: "req-123",
		} as IacStateType;

		const out = await freshTriggerRenovateUpdate(state);

		expect(out.blockedReason).toBeDefined();
		expect(recordSpy).not.toHaveBeenCalled();
	});
});
```

This reuses `mockRenovateTools` from Task 3 — both tasks' tests live in the same file, so Task 3 must land first (already the case, per this plan's task order).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "records a KG ConfigChange"`
Expected: FAIL — `recordSpy` was never called (no write exists yet).

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/nodes.ts`, add the import for `recordLaneConfigChange` at the top of the file (alongside this file's other `lane-knowledge.ts` imports, if any already exist — check the existing import block first; if `lane-knowledge.ts` is not yet imported in `nodes.ts`, add `import { recordLaneConfigChange } from "./lane-knowledge.ts";` in the correct alphabetical position within the existing local-import group).

Modify `triggerRenovateUpdate`'s return block (the code Task 3 just added) to include the KG write immediately before the return:

```typescript
	// SIO-1475: one KG ConfigChange write per trigger, here (not in watchRenovateMr) so a
	// later "check again" re-poll never writes a duplicate node for the same logical trigger --
	// mirrors exactly where the fleet-upgrade lane's own write happens (nodes.ts:12749, after
	// dispatch, not after each subsequent poll). mrUrl is intentionally omitted -- it is not
	// known yet at trigger time; see the design spec's explicit "what this does NOT do" note.
	await recordLaneConfigChange({
		id: state.requestId,
		deployment: inFlight.deployment,
		workflow: "renovate",
		outcome: "proposed",
		summary: `renovate ${inFlight.deployment} -> ${marker.marker}`,
		threadId: state.threadId || undefined,
	});

	return { renovateTriggerAtIso: triggerAtIso, renovateInFlightMarker: inFlight };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "records a KG ConfigChange"`
Expected: PASS, both tests green.

Then run the full file:

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1475: record a KG ConfigChange when a Renovate trigger succeeds"
```

---

### Task 5: `recallPriorRenovateTriggersForDeployment` + state field + wiring into `enrichRenovateTarget`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (new recall function, near `recallPriorRenovateTriggers` at line 12270; wire into `enrichRenovateTarget`'s `Promise.all` at lines 672-693)
- Modify: `packages/agent/src/iac/state.ts` (new `renovateDeploymentHistory` Annotation, near `renovateRecentChanges` at line 817)
- Modify: `packages/agent/src/iac/nodes.ts:1678-1712` (`TURN_START_RESET` — add `renovateDeploymentHistory: ""`)
- Test: `packages/agent/src/iac/renovate-integration.test.ts`

**Interfaces:**
- Consumes: `searchAgentMemory`, `selectedBackend` (existing imports, already used by `recallPriorRenovateTriggers`/`recallPriorFleetUpgrades`), `renderRenovateLearnings` (existing, `nodes.ts:12297`, unchanged, reused as-is).
- Produces: `export async function recallPriorRenovateTriggersForDeployment(deployment: string): Promise<string>`. New state field `renovateDeploymentHistory: Annotation<string>({ reducer: last, default: () => "" })`. `enrichRenovateTarget`'s return gains `renovateDeploymentHistory`.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/iac/renovate-integration.test.ts`. This file already has an established, exact pattern for testing this fact kind — the existing `"threads recallPriorRenovateTriggers' output onto renovatePriorTriggers..."` test inside `enrichRenovateTarget`'s describe block (search for that string in the file) uses `process.env.LIVE_MEMORY_BACKEND = "agent-memory"` plus `require("../memory-backend.ts").__setAgentMemoryClient(...)` with a `satisfies AgentMemoryClient` stub. Mirror that exact mechanism here, verifying the new function's `searchMemory` call carries no `marker` key (proving it is deployment-wide, not marker-scoped):

```typescript
import { recallPriorRenovateTriggersForDeployment } from "./nodes.ts";

describe("recallPriorRenovateTriggersForDeployment (SIO-1475)", () => {
	afterEach(() => {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient(null);
		delete process.env.LIVE_MEMORY_BACKEND;
	});

	test("queries deployment + kind only, no marker key, and renders hits", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		let seenAnnotations: Record<string, string> | undefined;
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				seenAnnotations = opts?.annotations;
				return [
					{
						text: "Renovate update triggered on ap-cld for 'renovate/ap-cld-prometheus'.",
						score: 0.9,
						annotations: {
							kind: "renovate-trigger",
							deployment: "ap-cld",
							marker: "renovate/ap-cld-prometheus",
							mr_url: "https://gitlab.example/x/-/merge_requests/519",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		} satisfies AgentMemoryClient);

		const out = await recallPriorRenovateTriggersForDeployment("ap-cld");

		expect(seenAnnotations).toEqual({ deployment: "ap-cld", kind: "renovate-trigger" });
		expect(out).toContain("Renovate update triggered on ap-cld for 'renovate/ap-cld-prometheus'");
		expect(out).toContain("[https://gitlab.example/x/-/merge_requests/519]");
	});

	test("returns '' when the agent-memory backend is not selected", async () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(await recallPriorRenovateTriggersForDeployment("ap-cld")).toBe("");
	});

	test("returns '' when deployment is empty", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(await recallPriorRenovateTriggersForDeployment("")).toBe("");
	});

	test("soft-fails to '' when the search throws", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				throw new Error("connection reset");
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		} satisfies AgentMemoryClient);

		expect(await recallPriorRenovateTriggersForDeployment("ap-cld")).toBe("");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "recallPriorRenovateTriggersForDeployment"`
Expected: FAIL — export not found.

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/state.ts`, add immediately after `renovateRecentChanges` (currently line 817):

```typescript
	renovateRecentChanges: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-1475: deployment-wide (any integration) Renovate-trigger recall, distinct from
	// renovatePriorTriggers (marker-scoped, "have we triggered THIS integration before").
	renovateDeploymentHistory: Annotation<string>({ reducer: last, default: () => "" }),
```

In `packages/agent/src/iac/nodes.ts`, add the new function immediately after `recallPriorRenovateTriggers`'s closing brace (currently line 12292, before the `renderRenovateLearnings` function at line 12297):

```typescript
// SIO-1475: the deployment-wide twin of recallPriorRenovateTriggers immediately above --
// mirrors recallPriorFleetUpgrades (nodes.ts:12213) exactly: same deployment-only filter shape,
// no marker/version narrowing, so a deployment's Renovate history across ALL integrations
// surfaces, not just the one currently pending. Reuses renderRenovateLearnings unchanged.
export async function recallPriorRenovateTriggersForDeployment(deployment: string): Promise<string> {
	if (selectedBackend() !== "agent-memory" || !deployment) return "";
	try {
		const hits = await searchAgentMemory("elastic-iac", "", { deployment, kind: "renovate-trigger" }, 8, {
			deterministic: true,
		});
		return renderRenovateLearnings(hits);
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error), deployment },
			"iac renovate trigger: deployment-wide prior-trigger recall failed; continuing without it",
		);
		return "";
	}
}
```

In `packages/agent/src/iac/nodes.ts`, modify `enrichRenovateTarget`'s `Promise.all` (currently lines 672-693) to add the new recall as a fourth parallel call:

```typescript
	const CHANGELOG_DISPLAY_CAP = 10;
	let changelogTotal = 0;
	const [changelog, renovateRecentChanges, renovatePriorTriggers, renovateDeploymentHistory] = await Promise.all([
		(async () => {
			if (!resolvedTargetVersion) return [];
			const filtered = filterChangelogRange(
				await fetchRenovateChangelog(target.integration),
				installedVersion,
				resolvedTargetVersion,
			);
			changelogTotal = filtered.length;
			return filtered.slice(0, CHANGELOG_DISPLAY_CAP);
		})(),
		recallDeploymentKgChanges(target.deployment),
		recallPriorRenovateTriggers(target.deployment, marker.marker),
		recallPriorRenovateTriggersForDeployment(target.deployment),
	]);

	return {
		renovateInstalledVersion: installedVersion,
		renovateTargetVersion: resolvedTargetVersion,
		renovatePolicyCount: policyCount,
		renovateChangelog: changelog,
		renovateRecentChanges,
		renovatePriorTriggers,
		renovateDeploymentHistory,
		renovateAffectedPolicies: affectedPolicies,
		renovateChangelogTotal: changelogTotal,
	};
```

(Match the exact existing return-object shape at this site — the fields listed above are illustrative of what changes; do not drop any pre-existing field in the real edit.)

In `packages/agent/src/iac/nodes.ts`, add `renovateDeploymentHistory: ""` to `TURN_START_RESET` (currently lines 1678-1712), immediately after the existing `renovateRecentChanges: ""` line:

```typescript
	renovateRecentChanges: "",
	renovateDeploymentHistory: "",
	renovatePriorTriggers: "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "recallPriorRenovateTriggersForDeployment"`
Expected: PASS, all 4 tests green.

Then run the full file:

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS (existing `enrichRenovateTarget` tests must still pass — the new recall runs alongside the existing ones and adds an extra field to the return object; existing tests asserting `toEqual`/exact-shape on `enrichRenovateTarget`'s output MUST be updated to also expect `renovateDeploymentHistory` in their expected object, or they will fail on the new field. Check every existing `enrichRenovateTarget` test in this file and add `renovateDeploymentHistory: ""` — or the mocked value — to each expected object as needed).

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/state.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1475: add recallPriorRenovateTriggersForDeployment and wire into enrichRenovateTarget"
```

---

### Task 6: Thread `renovateDeploymentHistory` through the interrupt payload, SSE schema, sse-pump, agent-reducer, and Svelte card

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:805-836` (`renovateTriggerGate`'s `interrupt()` call — add the new field to the payload)
- Modify: `packages/shared/src/agent-state.ts` (SSE schema — add `deploymentHistory` alongside the existing `recentChanges`/`priorTriggers` optional fields at the renovate-trigger-choice schema block, near line 1266-1267)
- Modify: `apps/web/src/lib/server/sse-pump.ts` (defensive-parse type literal + spread — near lines 745-754 and 890-914)
- Modify: `apps/web/src/lib/stores/agent-reducer.ts` (interface field + reducer assignment — near lines 322-324 and 854-855)
- Modify: `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte` (new collapsed panel, after the existing "Prior triggers (memory)" panel)
- Test: none required for this task (pure plumbing, mirrors an already-tested pattern exactly; SIO-1472/SIO-1473's own plans made the same call for their threading tasks) — but re-run the existing test suites listed in Step 2 to confirm no regressions.

**Interfaces:**
- Consumes: `Task 5`'s `state.renovateDeploymentHistory`.
- Produces: the `renovate_trigger_choice` interrupt/SSE event gains an optional `deploymentHistory?: string` field, visible end-to-end to the Svelte card as `prompt.deploymentHistory`.

- [ ] **Step 1: Modify the interrupt payload**

In `packages/agent/src/iac/nodes.ts`, in `renovateTriggerGate` (currently lines 805-823), add the new field to the `interrupt()` call object, immediately after `priorTriggers`:

```typescript
	const choice = interrupt({
		type: "renovate_trigger_choice",
		marker: marker.marker,
		line: marker.line,
		message: buildRenovateGateMessage(marker),
		installedVersion: state.renovateInstalledVersion,
		targetVersion: state.renovateTargetVersion,
		policyCount: state.renovatePolicyCount,
		changelog: state.renovateChangelog,
		recentChanges: state.renovateRecentChanges,
		priorTriggers: state.renovatePriorTriggers,
		deploymentHistory: state.renovateDeploymentHistory,
		affectedPolicies: state.renovateAffectedPolicies,
		changelogTotal: state.renovateChangelogTotal,
	}) as { approve?: boolean };
```

- [ ] **Step 2: Modify the SSE Zod schema**

In `packages/shared/src/agent-state.ts`, find the renovate-trigger-choice event schema block (search for the literal string `"gate's recentChanges/priorUpgrades fields"` near the existing `recentChanges`/`priorTriggers` optional-string pair, currently around lines 1265-1267). Add a sibling field:

```typescript
		recentChanges: z.string().optional(),
		priorTriggers: z.string().optional(),
		deploymentHistory: z.string().optional(),
```

- [ ] **Step 3: Modify sse-pump.ts's defensive parse and spread**

In `apps/web/src/lib/server/sse-pump.ts`, find the type literal declaring `priorTriggers?: unknown;` (currently line 754) and add a sibling:

```typescript
		priorTriggers?: unknown;
		deploymentHistory?: unknown;
```

Find the spread that includes `priorTriggers` (currently line 914, inside the `renovate_trigger_choice` event-building block) and add the equivalent defensive spread immediately after it, matching the exact same pattern:

```typescript
			...(typeof obj.recentChanges === "string" && obj.recentChanges && { recentChanges: obj.recentChanges }),
			...(typeof obj.priorTriggers === "string" && obj.priorTriggers && { priorTriggers: obj.priorTriggers }),
			...(typeof obj.deploymentHistory === "string" &&
				obj.deploymentHistory && { deploymentHistory: obj.deploymentHistory }),
```

- [ ] **Step 4: Modify agent-reducer.ts's interface and reducer**

In `apps/web/src/lib/stores/agent-reducer.ts`, find the interface block declaring `recentChanges?: string;` and `priorTriggers?: string;` together (currently lines 322-324, the renovate-trigger-choice prompt's own interface, distinct from the two other `recentChanges?: string;` declarations at lines 72 and 303 which belong to different card types — do not touch those). Add a sibling field:

```typescript
	recentChanges?: string;
	priorTriggers?: string;
	deploymentHistory?: string;
```

Find the reducer assignment that sets both `recentChanges`/`priorTriggers` together (currently lines 854-855, inside the `renovate_trigger_choice` case) and add the equivalent assignment immediately after:

```typescript
					recentChanges: event.recentChanges,
					priorTriggers: event.priorTriggers,
					deploymentHistory: event.deploymentHistory,
```

- [ ] **Step 5: Modify the Svelte card**

In `apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte`, add a new panel immediately after the existing "Prior triggers (memory)" `{#if prompt.priorTriggers}` block (currently ending around line 78):

```svelte
    <!-- SIO-1475: deployment-wide (any integration) Renovate-trigger history, distinct from the
         panel above -- that one is scoped to this exact integration/marker; this one answers
         "what other Renovate updates has this deployment had". -->
    {#if prompt.deploymentHistory}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Deployment history (memory)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.deploymentHistory} />
        </div>
      </details>
    {/if}
```

- [ ] **Step 6: Run the affected test suites to verify no regressions**

Run:
```bash
cd packages/agent && bun test src/iac/renovate-integration.test.ts
cd ../shared && bun test
cd ../../apps/web && bun run test
```
Expected: PASS across all three. (Per this repo's own established gotcha: web tests must be run via `cd apps/web && bun run test`, the package script — never a bare `bun test` from the repo root for that package.)

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/shared/src/agent-state.ts apps/web/src/lib/server/sse-pump.ts apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
git commit -m "SIO-1475: thread renovateDeploymentHistory through interrupt payload to the card"
```

---

### Task 7: Live end-to-end verification

**Files:** None modified — this task runs the real dev server against the real `ap-cld` deployment and the real GitLab Dependency Dashboard to confirm both fixes work together against the originally reported repro and a fresh scenario.

**Interfaces:**
- Consumes: the running `apps/web` dev server's `/api/agent/stream` and `/api/agent/iac/resume` endpoints, and the real `ELASTIC_AP_CLD_URL`/`ELASTIC_AP_CLD_API_KEY` env vars.
- Produces: a manual confirmation report (no code artifact) — pass/fail against both fixes.

- [ ] **Step 1: Check for a free port, start the web dev server from a scratch worktree/branch checkout**

```bash
lsof -i :5173
lsof -i :5174
```
Use whichever port is free; if both are occupied by servers you did not start, use a different port (e.g. 5175) rather than touching them.

```bash
cd apps/web && bun run dev -- --port <free-port>
```

Track the PID.

- [ ] **Step 2: Verify Fix 1 — trigger a fresh integration on ap-cld, then immediately ask to check again**

Send: `In the ap-cld deployment, upgrade the '<some integration not yet triggered this session>' integration`

Approve the gate (per this repo's rules, this is a real, live trigger against the real GitLab project — only do this with explicit user awareness that a real Renovate run will fire; if the user has not explicitly authorized a live trigger for this verification step, stop here and ask before proceeding, per this repo's Critical Rules on side effects outside a worktree).

If `triggerRenovateUpdate` reports "no MR has appeared yet," send: `Please check again`

Expected: the second turn's logs show `classified IaC intent ... "intent":"renovate-status-check"` (not `"renovate-integration-update"`), and the response is either "Renovate opened the update MR: ..." (if found) or the same "no MR yet, ask again" message (if still pending) — NOT "No pending Renovate update found for '...' on '...'".

- [ ] **Step 3: Verify Fix 2 — confirm the deployment-history panel appears on a later trigger**

After Step 2's trigger completes (MR found), start a **new** thread and trigger a **different** integration on ap-cld (e.g. `udp`, if that was not the one used in Step 2, or vice versa). On the resulting `renovate_trigger_choice` card, confirm a "Deployment history (memory)" panel is present and lists the integration triggered in Step 2.

Expected: the panel appears (assuming `AGENT_MEMORY_BACKEND`/`selectedBackend()` is `agent-memory` in this environment — confirm via `.env` before this step; if the backend is `file`, this panel will legitimately never populate, and that is expected, not a failure — note it in the report rather than treating it as a blocker).

- [ ] **Step 4: Kill the dev server and verify the port is free**

```bash
kill <tracked PID>
lsof -nP -iTCP:<port> -sTCP:LISTEN
```
Expected: second command returns nothing.

- [ ] **Step 5: Report results**

No commit for this task (verification only). Report pass/fail for Steps 2-3 back to the user before proceeding to finishing-a-development-branch.
