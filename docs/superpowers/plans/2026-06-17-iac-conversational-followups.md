# elastic-iac Conversational Follow-ups + Per-Outcome Completion Chip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `elastic-iac` agent answer conversational follow-ups about its own prior answer (a new `converse` lane), and render each turn's true outcome (rejected/declined/blocked/unsupported/pipeline-failed/completed) instead of an unconditional green "Completed" chip.

**Architecture:** Two coupled changes in one PR. (1) A `converse` intent + `converseIac` node that passes full `state.messages` to the LLM over the read-only tool subset (explain-only), gated on `isFollowUp` so first turns and genuine new actions still route correctly — mirroring the incident graph's `respond()` and `looksLikeFleetStatusCheck` guard idioms. (2) A pure `iacTurnOutcome(state)` helper surfaced on the `done` SSE event, rendered by `CompletedProgress.svelte`.

**Tech Stack:** Bun, TypeScript (strict, no `any`), LangGraph (`@langchain/langgraph`), SvelteKit (Svelte 5 runes), `bun:test`, Biome.

**Ticket:** [SIO-930](https://linear.app/siobytes/issue/SIO-930). **Spec:** `docs/superpowers/specs/2026-06-17-iac-conversational-followups-design.md`. **Branch:** `SIO-930-iac-converse-followups` (already created; spec already committed).

---

## File structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/agent/src/iac/state.ts` | add `"converse"` to `intent` union; add `isFollowUp` annotation | Modified |
| `packages/agent/src/iac/nodes.ts` | `intentFromText` + type; pure `coerceConverseIntent`; `classifyIacIntent` wiring + prompt; `converseIac` node; pure `iacTurnOutcome` + `IacTurnOutcome` type | Modified |
| `packages/agent/src/iac/graph.ts` | register `converseIac`; route `converse`; edge to END | Modified |
| `packages/agent/src/index.ts` | export `iacTurnOutcome`, `type IacTurnOutcome` | Modified |
| `apps/web/src/lib/server/agent.ts` | thread `isFollowUp` into IaC initial state; `getIacTurnOutcome(threadId)` | Modified |
| `apps/web/src/routes/api/agent/stream/+server.ts` | include `outcome` on IaC `done` | Modified |
| `apps/web/src/routes/api/agent/iac/resume/+server.ts` | include `outcome` on `done` | Modified |
| `apps/web/src/lib/stores/agent-reducer.ts` | `lastOutcome` field + `done` case | Modified |
| `apps/web/src/lib/stores/agent.svelte.ts` | mirror `lastOutcome`; put it on the assistant `ChatMessage` | Modified |
| `apps/web/src/lib/components/CompletedProgress.svelte` | per-outcome icon/color/label | Modified |
| `apps/web/src/lib/components/ChatMessage.svelte` | pass `outcome` prop | Modified |
| `packages/agent/src/iac/converse.test.ts` | `intentFromText`/`coerceConverseIntent`/`converseIac` tests | Created |
| `packages/agent/src/iac/outcome.test.ts` | `iacTurnOutcome` tests | Created |
| `apps/web/src/lib/stores/agent.handleEvent.test.ts` | `done` outcome reducer test | Modified |

---

## Task 1: Add `converse` to the intent type + `isFollowUp` to IacState

**Files:**
- Modify: `packages/agent/src/iac/state.ts:363` (intent union) and `:445` (add annotation before the closing `});`)

- [ ] **Step 1: Add `"converse"` to the `intent` annotation union**

In `packages/agent/src/iac/state.ts`, replace the `intent` annotation (currently at line 363):

```ts
	// SIO-913: "fleet-upgrade" enters the Fleet agent binary-upgrade sub-flow (preview -> gate -> apply).
	// SIO-930: "converse" answers a conversational follow-up ABOUT the agent's own prior answer
	// (explain/critique), with full conversation history, over the read-only tool subset. Selectable
	// only on a follow-up turn (see coerceConverseIntent).
	intent: Annotation<
		"info" | "gitops" | "pipeline-status" | "drift" | "synthetics-drift" | "fleet-upgrade" | "converse" | null
	>({
		reducer: last,
		default: () => null,
	}),
```

- [ ] **Step 2: Add the `isFollowUp` annotation**

In `packages/agent/src/iac/state.ts`, immediately before the closing `});` of `IacState` (after the `fleetApplyPipelineId` annotation at line 444), add:

```ts
	// SIO-930: set by the request (UI message-count signal). Gates whether the conversational
	// "converse" intent is selectable -- a first turn cannot be a follow-up about a prior answer.
	isFollowUp: Annotation<boolean>({ reducer: last, default: () => false }),
```

- [ ] **Step 3: Verify typecheck still passes for the agent package**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: PASS (the union widened; `intentFromText`'s return type is updated in Task 2, but the annotation alone compiles).
Note: if this reports an error in `nodes.ts` about `intentFromText` not being assignable, that is expected and fixed in Task 2 — proceed.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/iac/state.ts
git commit -m "SIO-930: add converse intent + isFollowUp to IacState"
```

---

## Task 2: `intentFromText` maps `converse`

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:250-268` (`intentFromText`)
- Test: `packages/agent/src/iac/converse.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/iac/converse.test.ts`:

```ts
// agent/src/iac/converse.test.ts
import { describe, expect, test } from "bun:test";
import { intentFromText } from "./nodes.ts";

describe("intentFromText converse (SIO-930)", () => {
	test("maps an explicit converse reply to converse", () => {
		expect(intentFromText("converse")).toBe("converse");
		expect(intentFromText("CONVERSE")).toBe("converse");
		expect(intentFromText("the answer is converse")).toBe("converse");
	});

	test("converse does not steal the other intents", () => {
		expect(intentFromText("gitops")).toBe("gitops");
		expect(intentFromText("pipeline-status")).toBe("pipeline-status");
		expect(intentFromText("drift")).toBe("drift");
		expect(intentFromText("info")).toBe("info");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: FAIL — `intentFromText("converse")` returns `"info"` (the default), not `"converse"`.

- [ ] **Step 3: Update `intentFromText`**

In `packages/agent/src/iac/nodes.ts`, change the return type and add the `converse` branch. Replace the signature line (currently line 252):

```ts
): "info" | "gitops" | "pipeline-status" | "drift" | "synthetics-drift" | "fleet-upgrade" | "converse" {
```

Then add this branch immediately AFTER the `gitops` check and BEFORE `return "info";` (currently lines 266-267):

```ts
	// SIO-930: conversational follow-up about the agent's own prior answer.
	if (r.includes("converse")) return "converse";
	return "info";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/converse.test.ts
git commit -m "SIO-930: intentFromText maps converse"
```

---

## Task 3: `coerceConverseIntent` — gate converse on isFollowUp

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add pure helper near `looksLikeFleetStatusCheck`, ~line 304)
- Test: `packages/agent/src/iac/converse.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/iac/converse.test.ts`:

```ts
import { coerceConverseIntent } from "./nodes.ts";

describe("coerceConverseIntent (SIO-930)", () => {
	test("keeps converse on a follow-up turn", () => {
		expect(coerceConverseIntent("converse", true)).toBe("converse");
	});

	test("downgrades converse to info on a first turn", () => {
		expect(coerceConverseIntent("converse", false)).toBe("info");
	});

	test("never touches a non-converse intent", () => {
		expect(coerceConverseIntent("gitops", true)).toBe("gitops");
		expect(coerceConverseIntent("gitops", false)).toBe("gitops");
		expect(coerceConverseIntent("pipeline-status", false)).toBe("pipeline-status");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: FAIL — `coerceConverseIntent` is not exported / not defined.

- [ ] **Step 3: Add the pure helper**

In `packages/agent/src/iac/nodes.ts`, immediately AFTER `looksLikeFleetStatusCheck` (it ends at line 303 with `}`), add:

```ts
// SIO-930: "converse" answers a follow-up ABOUT the agent's own prior answer, so it is only
// meaningful when there IS a prior turn. The classifier LLM can occasionally emit "converse" on a
// first message (mistaking a fresh question for a follow-up); coerce it back to the safe read-only
// "info" path in that case. This is the deterministic guard half of the converse gate (the LLM is
// still told converse exists). (Pure; unit-tested.)
export function coerceConverseIntent<T extends string>(intent: T, isFollowUp: boolean): T | "info" {
	if (intent === "converse" && !isFollowUp) return "info";
	return intent;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/converse.test.ts
git commit -m "SIO-930: coerceConverseIntent gates converse on isFollowUp"
```

---

## Task 4: Wire `classifyIacIntent` — prompt option + guard

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts:308-355` (`classifyIacIntent`)

This task has no new unit test of its own (it composes `intentFromText` + `coerceConverseIntent`, both tested; the LLM call is non-deterministic). The integration behavior is covered by the manual probe in Verification.

- [ ] **Step 1: Add the converse option to the classifier prompt**

In `packages/agent/src/iac/nodes.ts`, inside `classifyIacIntent`'s `sys` string, add this bullet immediately BEFORE the final "Reply with ONLY one word" line (currently line 347):

```ts
		"- 'converse': a CONVERSATIONAL follow-up about the agent's OWN previous answer or proposal -- " +
		"asking why it did something, to explain or justify it, to critique it, or reacting to it -- NOT a " +
		"request to change infrastructure. Examples: 'why was that wrong?', 'explain that', 'what would you " +
		"change about that policy?', 'I don't think that config is complete'. If the user instead asks for a " +
		"NEW change (even right after a proposal), that is 'gitops', not 'converse'.\n" +
```

- [ ] **Step 2: Update the final instruction line to list converse**

Replace the "Reply with ONLY one word" line (currently line 347-348) with:

```ts
		"Reply with ONLY one word: 'info', 'gitops', 'fleet-upgrade', 'drift', 'synthetics-drift', " +
		"'pipeline-status', or 'converse'. " +
		"If the user asks for a recommendation or 'should I…' that implies a single change, answer 'gitops'.";
```

- [ ] **Step 3: Apply the deterministic guard to the result**

In `classifyIacIntent`, replace the result-mapping line (currently line 350, `const intent = intentFromText(String(res.content));`) with:

```ts
	// SIO-930: gate converse on a real follow-up turn (the LLM can mis-emit it on a first message).
	const intent = coerceConverseIntent(intentFromText(String(res.content)), state.isFollowUp);
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: PASS — `intentFromText` now returns the widened union (incl. `converse`), `state.isFollowUp` exists (Task 1), and the `{ intent }` return matches the annotation.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts
git commit -m "SIO-930: classifyIacIntent offers converse, gated on isFollowUp"
```

---

## Task 5: `converseIac` node (explain-only, full history)

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add node after `answerInfo`, ~line 572)
- Test: `packages/agent/src/iac/converse.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/iac/converse.test.ts`. This drives `converseIac` with a mocked LLM + mocked tools so it is deterministic and never hits the network:

```ts
import { mock } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

describe("converseIac (SIO-930)", () => {
	test("answers from history with no tool calls and never blocks/MRs", async () => {
		// Mock the LLM to return a no-tool-call AIMessage (the common case: pure explanation).
		mock.module("../llm.ts", () => ({
			createLlm: () => ({ invoke: async () => new AIMessage("The delete phase had no delete action.") }),
			createLlmWithTools: () => ({
				invoke: async () => new AIMessage({ content: "The delete phase had no delete action.", tool_calls: [] }),
			}),
		}));
		// Mock the MCP bridge so infoTools() returns an empty set (no network).
		mock.module("../mcp-bridge.ts", () => ({
			getToolsForDataSource: () => [],
			getConnectedServers: () => ["elastic-iac-mcp"],
		}));
		const { converseIac } = await import("./nodes.ts");

		const state = asIacState({
			isFollowUp: true,
			messages: [
				new HumanMessage("propose a tiered ILM policy"),
				new AIMessage("Here is a policy with hot/warm/cold/delete."),
				new HumanMessage("why was that config wrong?"),
			],
		});
		const out = await converseIac(state);

		expect(out.messages?.length).toBe(1);
		expect(String(out.messages?.[0]?.content)).toContain("delete");
		// explain-only: never sets a blocked reason, never opens an MR
		expect(out.blockedReason).toBeUndefined();
		expect(out.mrUrl).toBeUndefined();
	});
});
```

Note: this test calls `mock.module` — per `reference_mock_pollution_own_in_beforeeach`, keep these mocks scoped to this file; `converse.test.ts` exercises pure helpers in earlier `describe`s that don't import the mocked modules at module load (they import `./nodes.ts` once). To avoid load-order pollution, this `describe` does a dynamic `await import("./nodes.ts")` AFTER the mocks are set. The earlier static `import { intentFromText, coerceConverseIntent }` is fine because those are pure and don't touch `llm.ts`/`mcp-bridge.ts` at call time.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: FAIL — `converseIac` is not exported.

- [ ] **Step 3: Implement `converseIac`**

In `packages/agent/src/iac/nodes.ts`, immediately AFTER `answerInfo` (it ends at line 572 with `}`), add:

```ts
// SIO-930: conversational follow-up lane. Unlike every other IaC node (which reads only the latest
// human message via lastHumanText), this passes the FULL conversation history so it can explain or
// justify the agent's own prior answer -- mirroring the incident graph's responder.ts. Explain-only:
// it binds ONLY the read-only INFO_TOOL_NAMES subset (physically cannot draft/branch/open an MR). If
// the user wants a change made, it tells them to ask directly (which re-enters the gitops gate).
const CONVERSE_GUARDRAIL =
	"This is a conversational follow-up about your previous answer in the conversation above. Explain, " +
	"justify, or critique it directly and concisely. You MAY use the read-only Elastic tools to ground " +
	"your answer in live state. You must NOT draft Terraform, edit configuration, create a branch, or open " +
	"a merge request. If the user wants a change made, tell them to ask for it directly and it will go " +
	"through the normal review-gated proposal flow.";

export async function converseIac(state: IacStateType): Promise<Partial<IacStateType>> {
	const tools = infoTools();
	const sys = `${buildSystemPrompt(getAgentByName(AGENT))}\n\n${CONVERSE_GUARDRAIL}`;

	// No read tools available: answer from history alone (still useful -- it's an explanation).
	if (tools.length === 0) {
		const res = await createLlm("iacConverse", AGENT).invoke([new SystemMessage(sys), ...state.messages]);
		return { messages: [new AIMessage(String(res.content))] };
	}

	const llm = createLlmWithTools("iacConverse", tools, AGENT);
	const toolNames = new Set(tools.map((t) => t.name));
	const convo: BaseMessage[] = [new SystemMessage(sys), ...state.messages];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = toolNames.has(call.name)
				? await callTool(call.name, (call.args ?? {}) as Record<string, unknown>)
				: `[${call.name} is not an allowed read tool]`;
			convo.push(new ToolMessage({ content: result, tool_call_id: call.id ?? call.name }));
		}
	}
	const final = await createLlm("iacConverse", AGENT).invoke([
		...convo,
		new HumanMessage("Answer the user's follow-up now using what you've gathered."),
	]);
	return { messages: [new AIMessage(String(final.content))] };
}
```

Note: `iacConverse` is a new `LlmRole`-style label string passed to `createLlm`/`createLlmWithTools`. Confirm these accept an arbitrary role string the same way `"iacReader"` is used in `answerInfo`; if the role is a strict union, add `"iacConverse"` to it where `"iacReader"` is defined. (Check: `grep -n "iacReader" packages/agent/src/llm.ts` — if it appears in a union, extend it; if `createLlm` takes `string`, no change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/converse.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/converse.test.ts
git commit -m "SIO-930: converseIac node (explain-only, full history)"
```

---

## Task 6: Wire `converseIac` into the graph

**Files:**
- Modify: `packages/agent/src/iac/graph.ts:5-31` (import), `:81-96` (conditional edge), and add node + END edge

- [ ] **Step 1: Import the node**

In `packages/agent/src/iac/graph.ts`, add `converseIac,` to the import block from `./nodes.ts` (alphabetically near `classifyIacIntent`, currently imported around line 11-13). Insert after the line importing `classifyIacIntent`... actually the import is a single destructured block (lines 5-31); add `converseIac,` on its own line, e.g. after `classifyIacIntent,` isn't present — the import lists functions; add:

```ts
	converseIac,
```

(Place it after `bootstrapIac,` to keep it grouped with the other nodes; exact alphabetical position is enforced by Biome in Step 5.)

- [ ] **Step 2: Register the node**

In `buildIacGraph`, after `.addNode("answerInfo", answerInfo)` (line 43), add:

```ts
		.addNode("converseIac", converseIac)
```

- [ ] **Step 3: Route `converse` from the classifier fan-out**

Replace the `classifyIacIntent` conditional edge (currently lines 81-96) so `converse` routes to `converseIac`. The new block:

```ts
		.addConditionalEdges(
			"classifyIacIntent",
			(s) =>
				s.intent === "gitops"
					? "parseIntent"
					: s.intent === "fleet-upgrade"
						? "detectFleetUpgrade"
						: s.intent === "synthetics-drift"
							? "detectSyntheticsDrift"
							: s.intent === "drift"
								? "detectDrift"
								: s.intent === "pipeline-status"
									? "watchPipeline"
									: s.intent === "converse"
										? "converseIac"
										: "answerInfo",
			[
				"parseIntent",
				"detectFleetUpgrade",
				"detectSyntheticsDrift",
				"detectDrift",
				"answerInfo",
				"watchPipeline",
				"converseIac",
			],
		)
```

- [ ] **Step 4: Add the terminal edge**

After `.addEdge("answerInfo", END)` (line 97), add:

```ts
		.addEdge("converseIac", END)
```

- [ ] **Step 5: Verify typecheck + lint**

Run: `bun run --filter @devops-agent/agent typecheck && bun run lint`
Expected: PASS (Biome may reorder the import — let `bun run lint:fix` handle it if it flags).

- [ ] **Step 6: Run the IaC graph tests**

Run: `bun test packages/agent/src/iac/graph.test.ts`
Expected: PASS (the existing graph compiles with the new node/edge; if a test asserts an exact node count, update it to include `converseIac`).

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/iac/graph.ts
git commit -m "SIO-930: route converse -> converseIac -> END in the IaC graph"
```

---

## Task 7: `iacTurnOutcome` pure helper

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add helper + type, near `isTerminalPipelineStatus` ~line 3470)
- Test: `packages/agent/src/iac/outcome.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/iac/outcome.test.ts`:

```ts
// agent/src/iac/outcome.test.ts
import { describe, expect, test } from "bun:test";
import { iacTurnOutcome } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const s = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

describe("iacTurnOutcome (SIO-930)", () => {
	test("rejected when the plan-review gate was rejected", () => {
		expect(iacTurnOutcome(s({ reviewDecision: "rejected" }))).toBe("rejected");
	});

	test("declined when the synthetics push was declined", () => {
		expect(iacTurnOutcome(s({ syntheticsPushApproved: false, syntheticsDriftReport: { deployment: "x" } as never }))).toBe(
			"declined",
		);
	});

	test("declined when the fleet upgrade was declined", () => {
		expect(iacTurnOutcome(s({ fleetUpgradeApproved: false, fleetUpgradeReport: { deployment: "x" } as never }))).toBe(
			"declined",
		);
	});

	test("unsupported when blocked by a workflow:other capability message", () => {
		expect(
			iacTurnOutcome(s({ blockedReason: "No proposer for this request (workflow 'other').", iacRequest: { workflow: "other", isProd: false } })),
		).toBe("unsupported");
	});

	test("blocked when a guard set a blockedReason (non-other workflow)", () => {
		expect(
			iacTurnOutcome(s({ blockedReason: "Cannot proceed: prod not named.", iacRequest: { workflow: "version-upgrade", isProd: false } })),
		).toBe("blocked");
	});

	test("pipeline-failed on a terminal failed pipeline with no block/decision", () => {
		expect(iacTurnOutcome(s({ pipelineStatus: "failed" }))).toBe("pipeline-failed");
	});

	test("completed by default (MR opened / info answered / converse)", () => {
		expect(iacTurnOutcome(s({ mrUrl: "https://gitlab/mr/1", pipelineStatus: "success" }))).toBe("completed");
		expect(iacTurnOutcome(s({}))).toBe("completed");
	});

	test("a human rejection outranks a blockedReason", () => {
		expect(iacTurnOutcome(s({ reviewDecision: "rejected", blockedReason: "whatever" }))).toBe("rejected");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/iac/outcome.test.ts`
Expected: FAIL — `iacTurnOutcome` is not exported.

- [ ] **Step 3: Implement the helper**

In `packages/agent/src/iac/nodes.ts`, immediately BEFORE `isTerminalPipelineStatus` (line 3470), add:

```ts
// SIO-930: the user-facing outcome of one IaC turn, derived from terminal state, so the UI chip
// reflects what actually happened instead of an unconditional "Completed". Precedence: explicit human
// decisions (reject/decline) > a request we have no proposer for (unsupported) > a mechanical guard
// block > a failed CI pipeline > completed. (Pure; unit-tested.)
export type IacTurnOutcome = "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";

export function iacTurnOutcome(state: IacStateType): IacTurnOutcome {
	if (state.reviewDecision === "rejected") return "rejected";
	if (state.syntheticsPushApproved === false && state.syntheticsDriftReport) return "declined";
	if (state.fleetUpgradeApproved === false && state.fleetUpgradeReport) return "declined";
	if (state.blockedReason) {
		return state.iacRequest?.workflow === "other" ? "unsupported" : "blocked";
	}
	if (isTerminalPipelineStatus(state.pipelineStatus) && state.pipelineStatus === "failed") return "pipeline-failed";
	return "completed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agent/src/iac/outcome.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/outcome.test.ts
git commit -m "SIO-930: iacTurnOutcome derives the per-turn outcome from state"
```

---

## Task 8: Export outcome from the agent package

**Files:**
- Modify: `packages/agent/src/index.ts:14-16`

- [ ] **Step 1: Add the exports**

In `packages/agent/src/index.ts`, after the `buildIacGraph` export (line 14), add:

```ts
export { converseIac, iacTurnOutcome, type IacTurnOutcome } from "./iac/nodes.ts";
```

- [ ] **Step 2: Verify the agent package builds + the web app can resolve the import**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "SIO-930: export iacTurnOutcome + IacTurnOutcome from agent package"
```

---

## Task 9: Thread `isFollowUp` into the IaC graph + `getIacTurnOutcome`

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts:180` (IaC initial state) and `:314` (add helper after `getLastAssistantText`)

- [ ] **Step 1: Pass `isFollowUp` into the IaC initial state**

In `apps/web/src/lib/server/agent.ts`, in the `agentName === "elastic-iac"` branch, change the initial state (currently line 180):

```ts
			return iacGraph.streamEvents(
				{ messages: langchainMessages, requestId, isFollowUp: options.isFollowUp ?? false },
```

(`options.isFollowUp` already exists on the options type — it's used by the incident branch at line 206.)

- [ ] **Step 2: Add `getIacTurnOutcome`**

In `apps/web/src/lib/server/agent.ts`, immediately AFTER `getLastAssistantText` (ends line 314), add:

```ts
// SIO-930: the IaC graph streams its final message through the checkpointer (no output-node token
// stream), so the SSE handlers read terminal state here to label the completion chip. Mirrors
// getLastAssistantText's state access. Defaults to "completed" if state can't be read.
export async function getIacTurnOutcome(threadId: string): Promise<IacTurnOutcome> {
	try {
		const graph = await getIacGraph();
		const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
		return iacTurnOutcome(snapshot.values as IacStateType);
	} catch {
		return "completed";
	}
}
```

- [ ] **Step 3: Add the imports**

At the top of `apps/web/src/lib/server/agent.ts`, add `iacTurnOutcome` and `type IacTurnOutcome` and `type IacStateType` to the existing `@devops-agent/agent` import (where `buildIacGraph` is imported, near line 4). Verify with `grep -n "from \"@devops-agent/agent\"" apps/web/src/lib/server/agent.ts`. Add:

```ts
	type IacStateType,
	type IacTurnOutcome,
	iacTurnOutcome,
```

(Biome will order type-before-value per `reference_biome_type_before_value_imports`; run `lint:fix` if needed.)

- [ ] **Step 4: Verify typecheck**

Run: `bun run --filter @devops-agent/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/agent.ts
git commit -m "SIO-930: thread isFollowUp into IaC graph + getIacTurnOutcome helper"
```

---

## Task 10: Emit `outcome` on both IaC `done` events

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/+server.ts:109-159` (IaC branch `done`)
- Modify: `apps/web/src/routes/api/agent/iac/resume/+server.ts:97-102`

- [ ] **Step 1: stream/+server.ts — import + emit outcome (IaC branch only)**

In `apps/web/src/routes/api/agent/stream/+server.ts`, add `getIacTurnOutcome` to the `$lib/server/agent` import (line 8). Then in the `body.agentName === "elastic-iac"` branch, where it sends the `done` after `getLastAssistantText` (around line 118-121), change the `done` send to include the outcome:

```ts
								const finalText = await getLastAssistantText(threadId, "elastic-iac");
								if (finalText) send({ type: "message", content: finalText });
								const outcome = await getIacTurnOutcome(threadId);
								send({ type: "done", threadId, responseTime: Date.now() - startTime, toolsUsed, outcome });
```

Note: match the exact field set the existing IaC `done` uses (it currently sends `threadId`, `responseTime`, `toolsUsed`). Keep those, add `outcome`. Do NOT touch the non-IaC `done` at line 159.

- [ ] **Step 2: iac/resume/+server.ts — import + emit outcome**

In `apps/web/src/routes/api/agent/iac/resume/+server.ts`, add `getIacTurnOutcome` to the `$lib/server/agent` import (line 12). Then change the `done` send (line 102):

```ts
							const outcome = await getIacTurnOutcome(body.threadId);
							const responseTime = Date.now() - startTime;
							log.info({ responseTime, toolsUsed: toolsUsed.length, outcome }, "agent.iac.resume.end");
							send({ type: "done", threadId: body.threadId, responseTime, toolsUsed, outcome });
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run --filter @devops-agent/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/+server.ts apps/web/src/routes/api/agent/iac/resume/+server.ts
git commit -m "SIO-930: emit turn outcome on both IaC done events"
```

---

## Task 11: Store the outcome in the reducer

**Files:**
- Modify: `apps/web/src/lib/stores/agent-reducer.ts:270-309` (`ReducerState` + `initialReducerState`), `:386-395` (`done` case)
- Test: `apps/web/src/lib/stores/agent.handleEvent.test.ts:49`

- [ ] **Step 1: Write the failing test**

In `apps/web/src/lib/stores/agent.handleEvent.test.ts`, add after the existing "captures done event metadata" test (line 60):

```ts
	test("captures the IaC turn outcome from done", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "done",
			threadId: "t-1",
			responseTime: 100,
			outcome: "rejected",
		});
		expect(next.lastOutcome).toBe("rejected");
	});

	test("defaults outcome to completed when absent", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "done", threadId: "t-1", responseTime: 100 });
		expect(next.lastOutcome).toBe("completed");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/stores/agent.handleEvent.test.ts`
Expected: FAIL — `lastOutcome` does not exist on `ReducerState`.

- [ ] **Step 3: Add `lastOutcome` to `ReducerState`**

In `apps/web/src/lib/stores/agent-reducer.ts`, in `ReducerState` (after `lastConfidence` at line 281), add:

```ts
	// SIO-930: per-turn outcome from the IaC done event ("rejected"/"declined"/etc.); drives the
	// completion chip color/label. "completed" for the incident agent (which omits the field).
	lastOutcome: "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";
```

In `initialReducerState` (after `lastConfidence: undefined` at line 323), add:

```ts
		lastOutcome: "completed",
```

- [ ] **Step 4: Set it in the `done` case**

In the `done` case (line 387-395), add to the returned object:

```ts
				lastOutcome: event.outcome ?? "completed",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/web/src/lib/stores/agent.handleEvent.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify typecheck**

Run: `bun run --filter @devops-agent/web typecheck`
Expected: PASS (the reducer event param is loosely typed; `event.outcome` resolves).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/stores/agent.handleEvent.test.ts
git commit -m "SIO-930: store IaC turn outcome in the reducer"
```

---

## Task 12: Carry `outcome` onto the assistant message

**Files:**
- Modify: `apps/web/src/lib/stores/agent.svelte.ts:27-39` (`ChatMessage`), `:74` (`$state`), `:117-120` (reset), `:187-195` (message build), `:218` (snapshot), `:247` (sync-back)

- [ ] **Step 1: Add `outcome` to the `ChatMessage` interface**

In `apps/web/src/lib/stores/agent.svelte.ts`, in `interface ChatMessage` (after `confidence?: number;` line 39), add:

```ts
	outcome?: "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";
```

- [ ] **Step 2: Add the local rune state**

Near the other `last*` runes (after `let lastConfidence = ...`, find via `grep -n "lastConfidence = \$state" apps/web/src/lib/stores/agent.svelte.ts`), add:

```ts
	let lastOutcome = $state<"completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed">(
		"completed",
	);
```

- [ ] **Step 3: Reset it on new turns**

In every place the run resets state (there are resets near lines 117 and 201/403/455 — find via `grep -n "lastConfidence = undefined\|lastSuggestions = \[\]" apps/web/src/lib/stores/agent.svelte.ts`), add alongside:

```ts
		lastOutcome = "completed";
```

Add it specifically next to the reset at line ~119 (start of a run) and the post-finalize reset at line ~202. (The finalize reset is what clears it for the next turn.)

- [ ] **Step 4: Put it on the finalized assistant message**

In the message-build block (lines 183-195), add after `confidence: lastConfidence,`:

```ts
						outcome: lastOutcome,
```

- [ ] **Step 5: Include it in the reducer snapshot + sync-back**

In `handleEvent`, the `snapshot: ReducerState` object (lines 210-229) must include `lastOutcome,` (after `lastConfidence,` at line 221). And in the sync-back block where locals are reassigned from `next` (find via `grep -n "lastConfidence = next.lastConfidence" apps/web/src/lib/stores/agent.svelte.ts`, ~line 249), add:

```ts
			lastOutcome = next.lastOutcome;
```

- [ ] **Step 6: Verify typecheck**

Run: `bun run --filter @devops-agent/web typecheck`
Expected: PASS (the `snapshot` must satisfy `ReducerState`, which now requires `lastOutcome` — Step 5 supplies it).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/stores/agent.svelte.ts
git commit -m "SIO-930: carry turn outcome onto the assistant ChatMessage"
```

---

## Task 13: Render per-outcome chip in CompletedProgress

**Files:**
- Modify: `apps/web/src/lib/components/CompletedProgress.svelte:21-33` (props), `:87-104` (button markup)
- Modify: `apps/web/src/lib/components/ChatMessage.svelte:107-114` (pass prop)

- [ ] **Step 1: Pass the prop from ChatMessage**

In `apps/web/src/lib/components/ChatMessage.svelte`, in the `<CompletedProgress ... />` block (lines 108-113), add:

```svelte
            outcome={message.outcome}
```

- [ ] **Step 2: Accept the prop in CompletedProgress**

In `apps/web/src/lib/components/CompletedProgress.svelte`, add to the `$props()` destructure (lines 21-33). Add the field to both the binding and the type:

```ts
	let {
		responseTime,
		toolsUsed = [],
		completedNodes = new Map(),
		dataSourceResults,
		dataSourceFindings,
		outcome = "completed",
	}: {
		responseTime?: number;
		toolsUsed?: string[];
		completedNodes?: Map<string, { duration: number }>;
		dataSourceResults?: Map<string, DataSourceStatus>;
		dataSourceFindings?: Map<string, DataSourceFindings>;
		outcome?: "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";
	} = $props();
```

- [ ] **Step 3: Derive label + styles from outcome**

In the `<script>` (after `formattedTime`, line 68), add:

```ts
	const outcomeView = $derived.by(() => {
		switch (outcome) {
			case "rejected":
				return { label: "Plan rejected", icon: "x", text: "text-amber-700", bgFrom: "#fffbeb", bgTo: "#fef3c7", border: "#fde68a" };
			case "declined":
				return { label: "Declined", icon: "x", text: "text-amber-700", bgFrom: "#fffbeb", bgTo: "#fef3c7", border: "#fde68a" };
			case "blocked":
				return { label: "Blocked", icon: "x", text: "text-amber-700", bgFrom: "#fffbeb", bgTo: "#fef3c7", border: "#fde68a" };
			case "unsupported":
				return { label: "Not supported yet", icon: "info", text: "text-gray-600", bgFrom: "#f9fafb", bgTo: "#f3f4f6", border: "#e5e7eb" };
			case "pipeline-failed":
				return { label: "Pipeline failed", icon: "x", text: "text-red-700", bgFrom: "#fef2f2", bgTo: "#fee2e2", border: "#fecaca" };
			default:
				return { label: "Completed", icon: "check", text: "text-green-700", bgFrom: "#f0fdf4", bgTo: "#dcfce7", border: "#bbf7d0" };
		}
	});
	const isCompleted = $derived(outcome === "completed");
```

Note: confirm `Icon.svelte` supports `name="x"` and `name="info"`. Run `grep -n "case \"x\"\|case \"info\"\|x:\|info:" apps/web/src/lib/components/Icon.svelte` — if either is missing, use `name="alert"` / an existing close-ish icon, or fall back to `name="check"` only for completed and a neutral dot otherwise. (Do not invent icon names.)

- [ ] **Step 4: Use `outcomeView` in the button markup**

Replace the button + label markup (lines 89-104). The header button:

```svelte
    <button
      onclick={() => expanded = !expanded}
      class="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left"
      style="background: linear-gradient(135deg, {outcomeView.bgFrom}, {outcomeView.bgTo}); border: 1px solid {outcomeView.border};"
    >
      <Icon name={outcomeView.icon} class="w-3.5 h-3.5 {outcomeView.text}" />
      <span class="text-xs font-medium {outcomeView.text}">
        {outcomeView.label}{#if isCompleted && formattedTime} in {formattedTime}{/if}
        {#if isCompleted && dataSources.length > 0}
          <span class="text-green-500 font-normal">
            -- {dataSources.length} data source{dataSources.length !== 1 ? "s" : ""}
            {#if errorCount > 0}
              ({successCount} ok, {errorCount} failed)
            {/if}
          </span>
        {/if}
```

(The data-source suffix and the timing now show only for `completed`; the rest of the expandable body below is unchanged.)

- [ ] **Step 5: Verify typecheck + lint**

Run: `bun run --filter @devops-agent/web typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/components/CompletedProgress.svelte apps/web/src/lib/components/ChatMessage.svelte
git commit -m "SIO-930: per-outcome completion chip (color/icon/label)"
```

---

## Task 14: Full verification + Linear status

- [ ] **Step 1: Full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. Per `reference_main_preexisting_test_lint_failures`, if any RED appears, stash and rerun on `main` to confirm it is pre-existing (SIO-863/864/865 live-API + no-test-file failures are known); note pre-existing failures in the PR, do not fix them. Your new tests (`converse.test.ts`, `outcome.test.ts`, the reducer test) must be GREEN.

- [ ] **Step 2: Manual probe (requires services up)**

Confirm ports: `lsof -i :5173` (web) and `lsof -i :9086` (IaC MCP). If down, start with `bun run --filter @devops-agent/web dev` (and the IaC MCP per its package). Then:

```bash
# A. classify a conversational follow-up (isFollowUp:true) -> expect converse, an explanation
curl -sN localhost:5173/api/agent/stream -H 'content-type: application/json' -d '{
  "agentName":"elastic-iac","threadId":"sio930-probe","isFollowUp":true,
  "messages":[{"role":"user","content":"Why was that ILM config wrong?"}]
}' | grep -E 'classified|message|done'
```

Expected in the web logs: `classified IaC intent ... "intent":"converse"`. Expected in the stream: a `message` explaining, and a `done` with `"outcome"` present.

```bash
# B. a NEW action on a follow-up turn must still be gitops (not swallowed by converse)
curl -sN localhost:5173/api/agent/stream -H 'content-type: application/json' -d '{
  "agentName":"elastic-iac","threadId":"sio930-probe2","isFollowUp":true,
  "messages":[{"role":"user","content":"now downsize eu-b2b warm to 8 GB"}]
}' | grep -E 'classified'
```

Expected: `"intent":"gitops"`.

Then in the UI: propose a change, reject it at the gate, and confirm the chip reads amber "Plan rejected" (not green "Completed").

- [ ] **Step 3: Move SIO-930 to In Progress / In Review**

Set [SIO-930](https://linear.app/siobytes/issue/SIO-930) to "In Review" once the PR is open (NEVER "Done" without user approval).

- [ ] **Step 4: Open the PR**

Push the branch and open a PR (ready for review, never draft) targeting `main`, body summarizing the two fixes and linking SIO-930 + the spec. Do not push to `main` directly.

---

## Self-review notes

- **Spec coverage:** converse intent (T1-2), isFollowUp gate (T1,3,4,9), converseIac explain-only over read tools (T5), graph wiring (T6), iacTurnOutcome full taxonomy (T7), export (T8), wire onto both done events (T9-10), store+message+chip (T11-13), tests + manual probe incl. the exact reported regression and the "new action on follow-up stays gitops" case (T4 prompt + T14 probe). All spec sections map to a task.
- **Type consistency:** `IacTurnOutcome` union is identical in `nodes.ts` (T7), the agent export (T8), `getIacTurnOutcome` (T9), the reducer `lastOutcome` (T11), `ChatMessage.outcome` (T12), and the `CompletedProgress` prop (T13). `coerceConverseIntent` / `converseIac` / `iacTurnOutcome` / `getIacTurnOutcome` names are used consistently across tasks.
- **Known-gotcha guards baked in:** mock-pollution note (T5, ref `reference_mock_pollution_own_in_beforeeach`), biome type-import ordering (T9, ref `reference_biome_type_before_value_imports`), pre-existing-RED stash check (T14, ref `reference_main_preexisting_test_lint_failures`), "confirm Icon names / LlmRole union before using" verification sub-steps (T5,T13) so no invented identifiers slip in.
