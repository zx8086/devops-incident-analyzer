# SIO-739: Per-call LLM deadlines for post-validate nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the post-`validate` pipeline hang by giving `proposeMitigation` and `followUp` per-role wall-clock deadlines that soft-fail with a `partial_failure` SSE event, so the user always receives the validated report.

**Architecture:** Add an `invokeWithDeadline` helper to `packages/agent/src/llm.ts` that merges the LangGraph `RunnableConfig.signal` with a per-role `AbortSignal.timeout` via `AbortSignal.any`. Distinguish local-deadline aborts from external-graph aborts using a private `AbortController` so external cancels still propagate untouched. Add a `partialFailures` append-only state field. Wire the helper into `mitigation.ts` (Step 1 + Step 2) and `follow-up-generator.ts`. Emit a new additive `{type: "partial_failure", node, reason}` SSE event from `apps/web/src/routes/api/agent/stream/+server.ts`.

**Tech Stack:** Bun, TypeScript strict mode, `@langchain/aws` `ChatBedrockConverse`, `@langchain/langgraph` `Annotation`, `bun:test`, Zod (unchanged), SvelteKit SSE.

**Spec:** `docs/superpowers/specs/2026-05-12-sio-739-post-validate-llm-deadlines-design.md`

**Linear:** [SIO-739](https://linear.app/siobytes/issue/SIO-739)

---

## Task 1: Pure helper `getRoleDeadlineMs` + `ROLE_DEADLINES_MS` map

**Files:**
- Modify: `packages/agent/src/llm.ts` (add new exports below existing `ROLE_OVERRIDES` at line 53)
- Create test: `packages/agent/src/llm.invoke-with-deadline.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/agent/src/llm.invoke-with-deadline.test.ts`:

```typescript
// packages/agent/src/llm.invoke-with-deadline.test.ts
//
// SIO-739: per-role deadline lookup + invokeWithDeadline helper.

import { describe, expect, test } from "bun:test";
import { DeadlineExceededError, ROLE_DEADLINES_MS, getRoleDeadlineMs, invokeWithDeadline } from "./llm.ts";

describe("ROLE_DEADLINES_MS defaults", () => {
	test("mitigation default is 120000", () => {
		expect(ROLE_DEADLINES_MS.mitigation).toBe(120_000);
	});

	test("actionProposal default is 60000", () => {
		expect(ROLE_DEADLINES_MS.actionProposal).toBe(60_000);
	});

	test("followUp default is 60000", () => {
		expect(ROLE_DEADLINES_MS.followUp).toBe(60_000);
	});

	test("classifier default is 0 (no per-call timer)", () => {
		expect(ROLE_DEADLINES_MS.classifier).toBe(0);
	});
});

describe("getRoleDeadlineMs", () => {
	test("returns map default when env has no relevant key", () => {
		expect(getRoleDeadlineMs("mitigation", {})).toBe(120_000);
	});

	test("env override takes precedence", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "5000" })).toBe(5000);
	});

	test("env override of 0 is honoured (disables per-call timer)", () => {
		expect(getRoleDeadlineMs("followUp", { AGENT_LLM_TIMEOUT_FOLLOW_UP_MS: "0" })).toBe(0);
	});

	test("non-numeric env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "nope" })).toBe(120_000);
	});

	test("negative env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "-1" })).toBe(120_000);
	});

	test("empty string env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "" })).toBe(120_000);
	});

	test("camelCase role names use SCREAMING_SNAKE env keys", () => {
		expect(getRoleDeadlineMs("followUp", { AGENT_LLM_TIMEOUT_FOLLOW_UP_MS: "1234" })).toBe(1234);
		expect(getRoleDeadlineMs("actionProposal", { AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS: "2345" })).toBe(2345);
		expect(getRoleDeadlineMs("runbookSelector", { AGENT_LLM_TIMEOUT_RUNBOOK_SELECTOR_MS: "3456" })).toBe(3456);
	});

	test("falls through to map default for camelCase role when no env key present", () => {
		expect(getRoleDeadlineMs("followUp", {})).toBe(60_000);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail at import**

Run: `bun test packages/agent/src/llm.invoke-with-deadline.test.ts`
Expected: FAIL — `SyntaxError: Export named 'ROLE_DEADLINES_MS' not found in module 'llm.ts'`

- [ ] **Step 3: Add `ROLE_DEADLINES_MS`, `getRoleDeadlineMs`, and `DeadlineExceededError` to `llm.ts`**

In `packages/agent/src/llm.ts`, immediately after the existing `ROLE_OVERRIDES` constant (after line 53), add:

```typescript
// SIO-739: Per-role wall-clock deadline for non-streaming llm.invoke calls. A
// value of 0 disables the per-call timer for that role (the graph-level signal
// is still in force). Defaults cover the post-validate non-streaming hang
// surface; other roles opt in when they need it.
export const ROLE_DEADLINES_MS: Record<LlmRole, number> = {
	orchestrator: 0,
	classifier: 0,
	subAgent: 0,
	aggregator: 0,
	responder: 0,
	entityExtractor: 0,
	followUp: 60_000,
	normalizer: 0,
	mitigation: 120_000,
	actionProposal: 60_000,
	runbookSelector: 0,
};

// SIO-739: Convert camelCase LlmRole to SCREAMING_SNAKE for env-var keys.
function roleToEnvSegment(role: LlmRole): string {
	return role.replace(/([A-Z])/g, "_$1").toUpperCase();
}

export function getRoleDeadlineMs(role: LlmRole, env: NodeJS.ProcessEnv = process.env): number {
	const envKey = `AGENT_LLM_TIMEOUT_${roleToEnvSegment(role)}_MS`;
	const raw = env[envKey];
	if (raw != null && raw !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
	return ROLE_DEADLINES_MS[role];
}

export class DeadlineExceededError extends Error {
	constructor(
		public readonly role: LlmRole,
		public readonly deadlineMs: number,
	) {
		super(`LLM call for role '${role}' exceeded deadline of ${deadlineMs}ms`);
		this.name = "DeadlineExceededError";
	}
}
```

- [ ] **Step 4: Run the test and confirm the `ROLE_DEADLINES_MS` + `getRoleDeadlineMs` cases pass**

Run: `bun test packages/agent/src/llm.invoke-with-deadline.test.ts`
Expected: PASS for the `ROLE_DEADLINES_MS defaults` and `getRoleDeadlineMs` describe blocks. The file may have additional empty describe blocks added in later tasks — those should not exist yet.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/llm.ts packages/agent/src/llm.invoke-with-deadline.test.ts
git commit -m "SIO-739: add ROLE_DEADLINES_MS map + getRoleDeadlineMs lookup"
```

---

## Task 2: `invokeWithDeadline` helper — resolve / reject / hang paths

**Files:**
- Modify: `packages/agent/src/llm.ts` (append `invokeWithDeadline` at end of file)
- Modify: `packages/agent/src/llm.invoke-with-deadline.test.ts` (append `invokeWithDeadline` describe block)

- [ ] **Step 1: Add failing tests for `invokeWithDeadline`**

Append to `packages/agent/src/llm.invoke-with-deadline.test.ts`:

```typescript
describe("invokeWithDeadline", () => {
	type FakeLlm = {
		invoke: (
			messages: unknown,
			config?: { signal?: AbortSignal },
		) => Promise<{ content: string }>;
	};

	test("resolves before deadline → returns response", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "200";
		const llm: FakeLlm = {
			invoke: async () => {
				await Bun.sleep(10);
				return { content: "ok" };
			},
		};
		const result = await invokeWithDeadline(llm as unknown as Parameters<typeof invokeWithDeadline>[0], "mitigation", []);
		expect(result.content).toBe("ok");
	});

	test("rejects with non-abort error → rethrows unchanged, NOT DeadlineExceededError", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "200";
		const llm: FakeLlm = {
			invoke: async () => {
				throw new Error("boom");
			},
		};
		await expect(
			invokeWithDeadline(llm as unknown as Parameters<typeof invokeWithDeadline>[0], "mitigation", []),
		).rejects.toThrow("boom");
	});

	test("hangs past deadline → throws DeadlineExceededError with role + deadlineMs", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "50";
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				return await new Promise((_resolve, reject) => {
					config?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			},
		};
		let caught: unknown;
		try {
			await invokeWithDeadline(llm as unknown as Parameters<typeof invokeWithDeadline>[0], "mitigation", []);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DeadlineExceededError);
		expect((caught as DeadlineExceededError).role).toBe("mitigation");
		expect((caught as DeadlineExceededError).deadlineMs).toBe(50);
	});

	test("external signal aborts first → rethrows AbortError, NOT DeadlineExceededError", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "1000";
		const external = new AbortController();
		setTimeout(() => external.abort(), 20);
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				return await new Promise((_resolve, reject) => {
					config?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted by external signal");
						err.name = "AbortError";
						reject(err);
					});
				});
			},
		};
		let caught: unknown;
		try {
			await invokeWithDeadline(
				llm as unknown as Parameters<typeof invokeWithDeadline>[0],
				"mitigation",
				[],
				{ signal: external.signal },
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(DeadlineExceededError);
		expect((caught as Error).name).toBe("AbortError");
	});

	test("deadline = 0 → no local timer, llm.invoke runs without per-call abort", async () => {
		process.env.AGENT_LLM_TIMEOUT_CLASSIFIER_MS = "0";
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				// If a local timer fired, signal would be aborted; assert it stays open
				await Bun.sleep(80);
				expect(config?.signal?.aborted ?? false).toBe(false);
				return { content: "ok" };
			},
		};
		const result = await invokeWithDeadline(
			llm as unknown as Parameters<typeof invokeWithDeadline>[0],
			"classifier",
			[],
		);
		expect(result.content).toBe("ok");
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail at import**

Run: `bun test packages/agent/src/llm.invoke-with-deadline.test.ts`
Expected: FAIL — `SyntaxError: Export named 'invokeWithDeadline' not found in module 'llm.ts'`

- [ ] **Step 3: Implement `invokeWithDeadline` in `llm.ts`**

Append to `packages/agent/src/llm.ts`:

```typescript
// SIO-739: Wrap llm.invoke with a per-role wall-clock deadline merged into
// the LangGraph RunnableConfig signal. The local AbortController is private,
// so we can distinguish a local-deadline trip from an external graph abort
// and only convert the former into DeadlineExceededError.
type InvokableLlm = {
	invoke: (
		messages: unknown,
		config?: { signal?: AbortSignal; [key: string]: unknown },
	) => Promise<{ content: unknown }>;
};

export async function invokeWithDeadline<TLlm extends InvokableLlm>(
	llm: TLlm,
	role: LlmRole,
	messages: Parameters<TLlm["invoke"]>[0],
	config?: { signal?: AbortSignal; [key: string]: unknown },
): Promise<Awaited<ReturnType<TLlm["invoke"]>>> {
	const deadlineMs = getRoleDeadlineMs(role);

	// deadline === 0 → no per-call timer; just pass through.
	if (deadlineMs === 0) {
		return (await llm.invoke(messages, config)) as Awaited<ReturnType<TLlm["invoke"]>>;
	}

	const localController = new AbortController();
	const timer = setTimeout(() => localController.abort(), deadlineMs);
	const externalSignal = config?.signal;
	const merged = externalSignal
		? AbortSignal.any([externalSignal, localController.signal])
		: localController.signal;

	try {
		const response = await llm.invoke(messages, { ...config, signal: merged });
		return response as Awaited<ReturnType<TLlm["invoke"]>>;
	} catch (err) {
		if (
			localController.signal.aborted &&
			err instanceof Error &&
			err.name === "AbortError"
		) {
			throw new DeadlineExceededError(role, deadlineMs);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
```

- [ ] **Step 4: Run the tests and confirm all five `invokeWithDeadline` cases pass**

Run: `bun test packages/agent/src/llm.invoke-with-deadline.test.ts`
Expected: PASS for all `invokeWithDeadline` cases plus the earlier `ROLE_DEADLINES_MS defaults` and `getRoleDeadlineMs` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/llm.ts packages/agent/src/llm.invoke-with-deadline.test.ts
git commit -m "SIO-739: invokeWithDeadline helper with private AbortController"
```

---

## Task 3: Add `partialFailures` to AgentState

**Files:**
- Modify: `packages/agent/src/state.ts` (append annotation before closing `});`)
- Create test: `packages/agent/src/state-partial-failures.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/state-partial-failures.test.ts`:

```typescript
// packages/agent/src/state-partial-failures.test.ts
//
// SIO-739: partialFailures append reducer + default.

import { describe, expect, test } from "bun:test";
import { AgentState, type AgentStateType } from "./state.ts";

describe("AgentState.partialFailures", () => {
	test("default is empty array", () => {
		const spec = AgentState.spec as Record<
			string,
			{ default?: () => unknown }
		>;
		const fieldSpec = spec.partialFailures;
		expect(fieldSpec).toBeDefined();
		expect(fieldSpec?.default?.()).toEqual([]);
	});

	test("reducer appends new entries", () => {
		const spec = AgentState.spec as Record<
			string,
			{ reducer?: (prev: unknown, next: unknown) => unknown }
		>;
		const reducer = spec.partialFailures?.reducer;
		expect(reducer).toBeDefined();
		const result = reducer?.(
			[{ node: "proposeMitigation", reason: "timeout" }],
			[{ node: "followUp", reason: "timeout" }],
		);
		expect(result).toEqual([
			{ node: "proposeMitigation", reason: "timeout" },
			{ node: "followUp", reason: "timeout" },
		]);
	});

	test("AgentStateType compiles with partialFailures field", () => {
		// Type-level assertion: this assignment must compile under strict mode.
		const sample: Pick<AgentStateType, "partialFailures"> = {
			partialFailures: [{ node: "proposeMitigation", reason: "timeout" }],
		};
		expect(sample.partialFailures).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test packages/agent/src/state-partial-failures.test.ts`
Expected: FAIL — `fieldSpec` is `undefined` because the field doesn't exist yet.

- [ ] **Step 3: Add the annotation to `state.ts`**

In `packages/agent/src/state.ts`, immediately before the closing `});` of `AgentState = Annotation.Root({...})` (after the `selectedRunbooks` annotation at lines 213-216), add:

```typescript
	// SIO-739: Append-only list of nodes that soft-failed (e.g. per-call LLM
	// deadline exceeded). The SSE handler emits a partial_failure event for
	// each new entry; the graph still reaches END so the validated answer
	// can still be delivered.
	partialFailures: Annotation<Array<{ node: string; reason: string }>>({
		reducer: (prev, next) => [...prev, ...next],
		default: () => [],
	}),
```

- [ ] **Step 4: Run the test and confirm all three cases pass**

Run: `bun test packages/agent/src/state-partial-failures.test.ts`
Expected: PASS for all three cases.

- [ ] **Step 5: Run the whole agent package typecheck and existing tests to confirm no regressions**

Run: `bun run --filter @devops-agent/agent typecheck && bun test --filter @devops-agent/agent`
Expected: typecheck green; existing tests green; the new file's three tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/state.ts packages/agent/src/state-partial-failures.test.ts
git commit -m "SIO-739: add partialFailures append annotation to AgentState"
```

---

## Task 4: Wire `invokeWithDeadline` into `proposeMitigation`

**Files:**
- Modify: `packages/agent/src/mitigation.ts` (replace both `llm.invoke` callsites; add `partialFailures` to return; import helper + error)
- Create test: `packages/agent/src/mitigation.deadline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/mitigation.deadline.test.ts`:

```typescript
// packages/agent/src/mitigation.deadline.test.ts
//
// SIO-739: proposeMitigation soft-fails on per-call deadline.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIG_ENV = { ...process.env };

// Mock createLlm BEFORE importing the SUT so mitigation.ts picks up the mock.
const hangForever = mock(
	async (_messages: unknown, config?: { signal?: AbortSignal }) => {
		return await new Promise<{ content: string }>((_resolve, reject) => {
			config?.signal?.addEventListener("abort", () => {
				const err = new Error("Aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	},
);

const succeed = mock(async () => ({
	content: JSON.stringify({
		investigate: ["look here"],
		monitor: ["watch this"],
		escalate: ["page someone"],
		relatedRunbooks: [],
	}),
}));

let llmFactoryMode: "hangBoth" | "succeedThenHang" = "hangBoth";

mock.module("./llm.ts", async () => {
	const actual = await import("./llm.ts");
	return {
		...actual,
		createLlm: (_role: string) => {
			if (llmFactoryMode === "succeedThenHang") {
				// First call (mitigation) succeeds; second (actionProposal) hangs.
				// Bun mock.module returns the same factory every call, so track a counter.
				return { invoke: callCounter++ === 0 ? succeed : hangForever };
			}
			return { invoke: hangForever };
		},
	};
});

let callCounter = 0;

// Stub action tools so Step 2 runs (severity: high).
mock.module("./action-tools/executor.ts", () => ({
	getAvailableActionTools: () => ["notify-slack", "create-ticket"],
}));

mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
}));

import { proposeMitigation } from "./mitigation.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "50";
	process.env.AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS = "50";
	callCounter = 0;
	hangForever.mockClear();
	succeed.mockClear();
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "x".repeat(200),
		dataSourceContext: undefined,
		requestId: "test-request",
		suggestions: [],
		normalizedIncident: { severity: "high" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0.7,
		lowConfidence: false,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		...overrides,
	} as AgentStateType;
}

describe("proposeMitigation soft-fail on deadline", () => {
	test("Step 1 hangs → returns empty mitigationSteps + partialFailures entry", async () => {
		llmFactoryMode = "hangBoth";
		const result = await proposeMitigation(baseState());

		expect(result.mitigationSteps).toEqual({
			investigate: [],
			monitor: [],
			escalate: [],
			relatedRunbooks: [],
		});
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual(
			expect.arrayContaining([{ node: "proposeMitigation", reason: "timeout" }]),
		);
		expect(result.partialFailures).toEqual(
			expect.arrayContaining([
				{ node: "proposeMitigation.actionProposal", reason: "timeout" },
			]),
		);
	});

	test("Step 1 succeeds, Step 2 hangs → Step 1 results preserved + only Step 2 partialFailure", async () => {
		llmFactoryMode = "succeedThenHang";
		const result = await proposeMitigation(baseState());

		expect(result.mitigationSteps).toEqual({
			investigate: ["look here"],
			monitor: ["watch this"],
			escalate: ["page someone"],
			relatedRunbooks: [],
		});
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual([
			{ node: "proposeMitigation.actionProposal", reason: "timeout" },
		]);
	});

	test("test completes in under 1 second wall clock", async () => {
		llmFactoryMode = "hangBoth";
		const start = Date.now();
		await proposeMitigation(baseState());
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test packages/agent/src/mitigation.deadline.test.ts`
Expected: FAIL — `mitigation.ts` does not yet import `invokeWithDeadline` / `DeadlineExceededError`, so the existing catch-block converts the AbortError into a generic warn-and-continue. `partialFailures` will be missing from the return.

- [ ] **Step 3: Modify `mitigation.ts` to use `invokeWithDeadline` and emit `partialFailures`**

In `packages/agent/src/mitigation.ts`:

Replace the import block (lines 1-10) with:

```typescript
// agent/src/mitigation.ts

import { getLogger } from "@devops-agent/observability";
import type { MitigationSteps, PendingAction } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getAvailableActionTools } from "./action-tools/executor.ts";
import { DeadlineExceededError, createLlm, invokeWithDeadline } from "./llm.ts";
import { getRunbookFilenames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
```

Replace the entire `proposeMitigation` function body (from `export async function proposeMitigation` at line 84 to the closing `}` at line 184) with:

```typescript
export async function proposeMitigation(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const report = state.finalAnswer;
	if (!report || report.length < 50) {
		logger.info("No substantial report to generate mitigations from");
		return {
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			pendingActions: [],
		};
	}

	const confidence = state.confidenceScore;
	const confidenceHint =
		confidence > 0 && confidence < 0.6
			? "\n\nNOTE: Report confidence is below 0.6. Lead with broader investigation steps and explicitly note data gaps."
			: "";

	const queriedSources = state.targetDataSources;
	const sourceContext = queriedSources.length > 0 ? `\nQueried datasources: ${queriedSources.join(", ")}` : "";

	const truncated = report.slice(0, 3000);
	let mitigationSteps: MitigationSteps = { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] };
	let pendingActions: PendingAction[] = [];
	const partialFailures: Array<{ node: string; reason: string }> = [];

	// Step 1: Generate mitigation steps
	const llm = createLlm("mitigation");
	try {
		const response = await invokeWithDeadline(
			llm,
			"mitigation",
			[
				{ role: "system", content: `${buildMitigationPrompt()}${confidenceHint}${sourceContext}` },
				{ role: "human", content: truncated },
			],
			config,
		);

		const text = String(response.content);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = MitigationOutputSchema.parse(JSON.parse(jsonMatch[0]));
			mitigationSteps = { ...parsed };
			logger.info(
				{
					investigate: mitigationSteps.investigate.length,
					monitor: mitigationSteps.monitor.length,
					escalate: mitigationSteps.escalate.length,
					runbooks: mitigationSteps.relatedRunbooks.length,
				},
				"Mitigation steps generated",
			);
		} else {
			logger.warn("Failed to parse mitigation JSON from LLM response");
		}
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			logger.warn(
				{ role: error.role, deadlineMs: error.deadlineMs },
				"Mitigation step 1 exceeded deadline; soft-failing",
			);
			partialFailures.push({ node: "proposeMitigation", reason: "timeout" });
		} else {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Mitigation generation failed",
			);
		}
	}

	// Step 2: Generate action proposals (only if action tools are configured)
	const availableTools = getAvailableActionTools();
	const severity = state.normalizedIncident?.severity;
	const shouldPropose = availableTools.length > 0 && (severity === "critical" || severity === "high");

	if (shouldPropose) {
		const actionLlm = createLlm("actionProposal");
		try {
			const response = await invokeWithDeadline(
				actionLlm,
				"actionProposal",
				[
					{ role: "system", content: buildActionProposalPrompt(availableTools) },
					{
						role: "human",
						content: `Severity: ${severity}\nConfidence: ${confidence}\nDatasources: ${queriedSources.join(", ")}\n\n${truncated}`,
					},
				],
				config,
			);

			const text = String(response.content);
			const jsonMatch = text.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = ActionProposalSchema.parse(JSON.parse(jsonMatch[0]));
				pendingActions = parsed.actions
					.filter((a) => availableTools.includes(a.tool))
					.map((a) => ({
						id: crypto.randomUUID(),
						tool: a.tool,
						params: a.params,
						reason: a.reason,
					}));
				logger.info({ count: pendingActions.length }, "Action proposals generated");
			}
		} catch (error) {
			if (error instanceof DeadlineExceededError) {
				logger.warn(
					{ role: error.role, deadlineMs: error.deadlineMs },
					"Action proposal step exceeded deadline; soft-failing",
				);
				partialFailures.push({ node: "proposeMitigation.actionProposal", reason: "timeout" });
			} else {
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"Action proposal generation failed",
				);
			}
		}
	}

	return { mitigationSteps, pendingActions, partialFailures };
}
```

- [ ] **Step 4: Run the test and confirm all three cases pass**

Run: `bun test packages/agent/src/mitigation.deadline.test.ts`
Expected: PASS for all three cases. Wall clock under 1s.

- [ ] **Step 5: Typecheck the package**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/mitigation.ts packages/agent/src/mitigation.deadline.test.ts
git commit -m "SIO-739: mitigation node soft-fails with partialFailures on deadline"
```

---

## Task 5: Wire `invokeWithDeadline` into `generateSuggestions` (follow-up)

**Files:**
- Modify: `packages/agent/src/follow-up-generator.ts`
- Create test: `packages/agent/src/follow-up-generator.deadline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/follow-up-generator.deadline.test.ts`:

```typescript
// packages/agent/src/follow-up-generator.deadline.test.ts
//
// SIO-739: generateSuggestions soft-fails on per-call deadline.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIG_ENV = { ...process.env };

const hangForever = mock(
	async (_messages: unknown, config?: { signal?: AbortSignal }) => {
		return await new Promise<{ content: string }>((_resolve, reject) => {
			config?.signal?.addEventListener("abort", () => {
				const err = new Error("Aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	},
);

mock.module("./llm.ts", async () => {
	const actual = await import("./llm.ts");
	return {
		...actual,
		createLlm: () => ({ invoke: hangForever }),
	};
});

import { generateFallbackSuggestions, generateSuggestions } from "./follow-up-generator.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	process.env.AGENT_LLM_TIMEOUT_FOLLOW_UP_MS = "50";
	hangForever.mockClear();
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: [],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [
			{
				dataSourceId: "elastic",
				status: "success",
				data: "irrelevant",
				toolOutputs: [{ toolName: "elastic_cluster_health", output: "ok" }],
			},
		],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "x".repeat(200),
		dataSourceContext: undefined,
		requestId: "test-request",
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0.7,
		lowConfidence: false,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		...overrides,
	} as AgentStateType;
}

describe("generateSuggestions soft-fail on deadline", () => {
	test("LLM hangs → returns fallback suggestions + partialFailures entry", async () => {
		const result = await generateSuggestions(baseState());

		const expectedFallback = generateFallbackSuggestions(["elastic_cluster_health"]);
		expect(result.suggestions).toEqual(expectedFallback);
		expect(result.partialFailures).toEqual([{ node: "followUp", reason: "timeout" }]);
	});

	test("test completes in under 1 second wall clock", async () => {
		const start = Date.now();
		await generateSuggestions(baseState());
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test packages/agent/src/follow-up-generator.deadline.test.ts`
Expected: FAIL — `result.partialFailures` is `undefined`; the existing catch returns only `{ suggestions: ... }`.

- [ ] **Step 3: Modify `follow-up-generator.ts`**

In `packages/agent/src/follow-up-generator.ts`:

Replace the import block (lines 1-6) with:

```typescript
// agent/src/follow-up-generator.ts
import { getLogger } from "@devops-agent/observability";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DeadlineExceededError, createLlm, invokeWithDeadline } from "./llm.ts";
import type { AgentStateType } from "./state.ts";
```

Replace the `generateSuggestions` function body (from `export async function generateSuggestions` at line 76 to the closing `}` at line 109) with:

```typescript
// LangGraph node function -- inherits trace context via RunnableConfig
export async function generateSuggestions(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const toolsUsed = extractToolNamesFromResults(state);
	const responseText = state.finalAnswer;

	if (!responseText || responseText.length < 50) {
		logger.info("Short or missing response, using fallback suggestions");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}

	try {
		const llm = createLlm("followUp");
		const truncated = responseText.slice(0, 1000);
		const result = await invokeWithDeadline(
			llm,
			"followUp",
			[new SystemMessage(FOLLOW_UP_PROMPT), new HumanMessage(truncated)],
			config,
		);

		const content = typeof result.content === "string" ? result.content : "";
		const suggestions = parseSuggestions(content);
		if (suggestions) {
			logger.info({ count: suggestions.length }, "Generated follow-up suggestions");
			return { suggestions };
		}

		logger.warn("LLM suggestions did not pass validation, using fallbacks");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			logger.warn(
				{ role: error.role, deadlineMs: error.deadlineMs },
				"Follow-up suggestion generation exceeded deadline; soft-failing",
			);
			return {
				suggestions: generateFallbackSuggestions(toolsUsed),
				partialFailures: [{ node: "followUp", reason: "timeout" }],
			};
		}
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"LLM suggestion generation failed, using fallbacks",
		);
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}
}
```

- [ ] **Step 4: Run the test and confirm both cases pass**

Run: `bun test packages/agent/src/follow-up-generator.deadline.test.ts`
Expected: PASS. Wall clock under 1s.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @devops-agent/agent typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/follow-up-generator.ts packages/agent/src/follow-up-generator.deadline.test.ts
git commit -m "SIO-739: follow-up generator soft-fails with partialFailures on deadline"
```

---

## Task 6: Emit `partial_failure` SSE event from stream handler

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/+server.ts`
- Modify: `apps/web/src/routes/api/agent/stream/server.test.ts` (append new test block)

- [ ] **Step 1: Inspect the existing test file shape**

Read `apps/web/src/routes/api/agent/stream/server.test.ts` to see how events are asserted (you'll mirror the style for the new test block in Step 3 — the existing file uses a fake `invokeAgent` that yields a list of events). If the file uses a helper that maps events to SSE frames, reuse it. If the existing tests are integration-only (live invoke), skip Step 3 and instead manually verify in Step 7's smoke run; otherwise proceed to Step 3.

- [ ] **Step 2: Modify `+server.ts` — add `emittedFailures` Set + emission in `on_chain_end`**

In `apps/web/src/routes/api/agent/stream/+server.ts`:

Find the line declaring `nodeStartTimes` (currently line 98):

```typescript
								const nodeStartTimes = new Map<string, number>();
```

Add immediately below it:

```typescript
								const emittedFailures = new Set<string>();
```

Find the existing `on_chain_end` handler for `proposeMitigation` (currently lines 142-147):

```typescript
										// SIO-634, SIO-635: Emit pending action proposals for user confirmation
										if (event.name === "proposeMitigation") {
											const pendingActions = event.data?.output?.pendingActions;
											if (Array.isArray(pendingActions) && pendingActions.length > 0) {
												send({ type: "pending_actions", actions: pendingActions });
											}
										}
```

Add a new block immediately after that closing `}` (still inside the `if (event.event === "on_chain_end" && event.name && PIPELINE_NODES.has(event.name))` block):

```typescript
										// SIO-739: Emit partial_failure for any new entries added by this node.
										if (event.name === "proposeMitigation" || event.name === "followUp") {
											const partialFailures = event.data?.output?.partialFailures;
											if (Array.isArray(partialFailures)) {
												for (const failure of partialFailures) {
													if (
														typeof failure === "object" &&
														failure !== null &&
														typeof failure.node === "string" &&
														typeof failure.reason === "string"
													) {
														const key = `${failure.node}:${failure.reason}`;
														if (!emittedFailures.has(key)) {
															emittedFailures.add(key);
															send({
																type: "partial_failure",
																node: failure.node,
																reason: failure.reason,
															});
														}
													}
												}
											}
										}
```

- [ ] **Step 3: Add an SSE handler test (only if `server.test.ts` already supports a fake-event harness)**

If the existing file uses a fake event stream pattern (look for a `function* fakeEvents()` or similar), append a test like:

```typescript
test("emits partial_failure for each new partialFailures entry on proposeMitigation on_chain_end", async () => {
	const events = [
		{
			event: "on_chain_end",
			name: "proposeMitigation",
			data: {
				output: {
					partialFailures: [{ node: "proposeMitigation", reason: "timeout" }],
				},
			},
		},
	];
	const sse = await runFakeStream(events);
	expect(sse).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "partial_failure",
				node: "proposeMitigation",
				reason: "timeout",
			}),
		]),
	);
});

test("de-dups partial_failure events emitted with the same node+reason key", async () => {
	const events = [
		{
			event: "on_chain_end",
			name: "proposeMitigation",
			data: { output: { partialFailures: [{ node: "proposeMitigation", reason: "timeout" }] } },
		},
		{
			event: "on_chain_end",
			name: "followUp",
			data: { output: { partialFailures: [{ node: "proposeMitigation", reason: "timeout" }] } },
		},
	];
	const sse = await runFakeStream(events);
	const failures = sse.filter((e) => e.type === "partial_failure");
	expect(failures).toHaveLength(1);
});
```

If the file does NOT have such a harness, skip this step and rely on Task 7's smoke verification. Do NOT build a new harness for this PR — that's out of scope.

- [ ] **Step 4: Run the test suite**

Run: `bun test --filter @devops-agent/web`
Expected: existing tests still pass. New tests (if added in Step 3) pass.

- [ ] **Step 5: Typecheck both packages**

Run: `bun run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/+server.ts apps/web/src/routes/api/agent/stream/server.test.ts
git commit -m "SIO-739: SSE emits partial_failure event for soft-fail nodes"
```

(If `server.test.ts` was not modified, drop it from the git add command.)

---

## Task 7: Full verification (typecheck, lint, test, smoke)

**Files:** none modified; verification only.

- [ ] **Step 1: Workspace typecheck**

Run: `bun run typecheck`
Expected: every package green; zero errors.

- [ ] **Step 2: Workspace lint**

Run: `bun run lint`
Expected: zero violations. If Biome complains about import ordering in `llm.ts`, `mitigation.ts`, or `follow-up-generator.ts`, run `bun run lint:fix` and amend the last commit (`git commit --amend --no-edit`).

- [ ] **Step 3: Run the new tests only first to confirm focus**

Run: `bun test packages/agent/src/llm.invoke-with-deadline.test.ts packages/agent/src/state-partial-failures.test.ts packages/agent/src/mitigation.deadline.test.ts packages/agent/src/follow-up-generator.deadline.test.ts`
Expected: all green; total wall clock under 5s.

- [ ] **Step 4: Run the full agent package test suite**

Run: `bun test --filter @devops-agent/agent`
Expected: every test green; no regressions.

- [ ] **Step 5: Smoke run with an aggressive override**

In `.env` (or shell), set:

```bash
export AGENT_LLM_TIMEOUT_MITIGATION_MS=2000
```

Restart kafka-mcp and the web dev server (full restart — `bun --hot` does NOT re-resolve modules per memory `reference_bun_hot_does_not_reresolve_modules.md`).

Open `http://localhost:5173` and submit a prompt that will reach `proposeMitigation` (any production-style incident query).

Open DevTools → Network → the `stream` request. Confirm in the SSE event stream:
- A `partial_failure` event appears with `node: "proposeMitigation"`, `reason: "timeout"` — within ~2s after the `node_start` for `proposeMitigation`.
- The aggregator's `on_chat_model_stream` events still deliver the full answer.
- A final `done` event arrives.
- The chat UI shows the full report.

If the `partial_failure` does not appear, check server-side logs for `Mitigation step 1 exceeded deadline; soft-failing` — its presence proves the helper fired and the regression is downstream in the SSE handler.

- [ ] **Step 6: Pull the LangSmith trace and confirm**

Run from the repo root (replace `<key>` with `grep ^LANGSMITH_API_KEY= .env | cut -d= -f2`):

```bash
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=devops-incident-analyzer \
  langsmith-fetch traces /tmp/traces --limit 1 --include-metadata
```

In the latest trace, find the `proposeMitigation` span. Confirm its duration is ≤ 2.5s (not 25 minutes). The trace should show a thrown `DeadlineExceededError` rather than an open span.

- [ ] **Step 7: Unset the smoke override and re-run**

```bash
unset AGENT_LLM_TIMEOUT_MITIGATION_MS
```

Restart the web dev server. Re-run the same prompt. Confirm:
- No `partial_failure` event.
- Mitigation steps appear in the report.
- LangSmith trace shows `proposeMitigation` completed normally (single-digit seconds is fine).

- [ ] **Step 8: Commit the cleanup** (if `.env` was modified during smoke and reset)

If you reverted `.env` to remove the smoke override, ensure `git status` is clean — no uncommitted changes should remain.

---

## Task 8: Open the PR

**Files:** none modified directly; PR creation only.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin SIO-739-post-validate-llm-deadlines
```

(Use whatever branch name you actually checked out; if you've been working on `main`, create a branch now: `git switch -c SIO-739-post-validate-llm-deadlines` and re-push.)

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "SIO-739: per-call LLM deadlines for post-validate nodes" --body "$(cat <<'EOF'
## Summary

- Adds `invokeWithDeadline` helper in `packages/agent/src/llm.ts` that merges the LangGraph `RunnableConfig.signal` with a per-role `AbortSignal.timeout`, converting only local-deadline trips into `DeadlineExceededError` (external graph aborts pass through unchanged).
- Wires the helper into `proposeMitigation` (both Step 1 and Step 2) and `generateSuggestions`. On timeout the node soft-fails: empty mitigation/empty actions or fallback follow-up suggestions, and appends a `{node, reason}` entry to a new `partialFailures` annotation on `AgentState`.
- SSE handler emits a new additive `{type: "partial_failure", node, reason}` event from `on_chain_end` for `proposeMitigation` and `followUp` with de-dup on `${node}:${reason}`. Frontend ignores unknown event types — no UI change required.
- Per-role defaults: mitigation 120s, actionProposal 60s, followUp 60s. Overridable via `AGENT_LLM_TIMEOUT_<SCREAMING_SNAKE_ROLE>_MS` (e.g. `AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS`, `AGENT_LLM_TIMEOUT_FOLLOW_UP_MS`). All other roles get `0` (no per-call timer) and continue to rely on the graph-level 720s signal.

Spec: `docs/superpowers/specs/2026-05-12-sio-739-post-validate-llm-deadlines-design.md`
Plan: `docs/superpowers/plans/2026-05-12-sio-739-post-validate-llm-deadlines.md`

Closes SIO-739.

## Test plan

- [ ] `bun run typecheck` green
- [ ] `bun run lint` green
- [ ] `bun test --filter @devops-agent/agent` green
- [ ] Smoke: `AGENT_LLM_TIMEOUT_MITIGATION_MS=2000` produces `partial_failure` SSE event + full report still rendered
- [ ] Smoke: unset override → normal mitigation steps appear; no `partial_failure` emitted
- [ ] LangSmith trace confirms `proposeMitigation` ≤ 2.5s under override (no 25-min hang)
EOF
)"
```

- [ ] **Step 3: Move the Linear ticket**

Move SIO-739 from `Backlog` → `In Review` (NOT Done — that requires user approval per CLAUDE.md).

- [ ] **Step 4: Notify**

Report the PR URL back to the user and wait for review. After merge, smoke-verify on `main`, then move SIO-739 to Done (with explicit user approval) and begin SIO-738.

---

## Self-review

**Spec coverage:**
- Section 3.1 `invokeWithDeadline` helper → Task 2 ✓
- Section 3.2 `DeadlineExceededError` → Task 1 ✓
- Section 3.3 per-role deadline map + env getter → Task 1 ✓
- Section 3.4 soft-fail in nodes (mitigation Step 1 + Step 2, followUp) → Tasks 4 & 5 ✓
- Section 3.5 `partialFailures` state field → Task 3 ✓
- Section 3.6 SSE emission + de-dup Set → Task 6 ✓
- Section 4 tests (3 files) → Tasks 1/2 (helper), 3 (state), 4 (mitigation), 5 (followUp) ✓
- Section 5 acceptance criteria → Task 7 verification ✓

**Placeholder scan:** No "TBD", "TODO", "similar to Task N", or "add appropriate error handling" — every step shows the exact code or command.

**Type consistency:** `invokeWithDeadline`, `DeadlineExceededError`, `ROLE_DEADLINES_MS`, `getRoleDeadlineMs`, `partialFailures` named identically across spec, plan, code, and tests. `partialFailures` entry shape `{node: string, reason: string}` is consistent everywhere. Env var pattern `AGENT_LLM_TIMEOUT_<SCREAMING_SNAKE_ROLE>_MS` (camelCase roles converted via `roleToEnvSegment`) matches in code and verification commands.
