// packages/agent/src/runbook-selector.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { RunbookCatalogEntry } from "./prompt-context.ts";
import {
	RunbookSelectionFallbackError,
	runSelectRunbooks,
	type SelectRunbooksRuntime,
	type SeverityFallbackConfig,
} from "./runbook-selector.ts";
import type { AgentStateType } from "./state.ts";

// SIO-640: All tests inject runtime deps directly via runSelectRunbooks()
// rather than mocking sibling modules. This avoids the mock.module
// process-wide scope problem from SIO-635 that bit Task 5/6.

const DEFAULT_CATALOG: RunbookCatalogEntry[] = [
	{ filename: "a.md", title: "Runbook A", summary: "Pattern A summary" },
	{ filename: "b.md", title: "Runbook B", summary: "Pattern B summary" },
	{ filename: "c.md", title: "Runbook C", summary: "Pattern C summary" },
];

const FALLBACK_CONFIG: SeverityFallbackConfig = {
	critical: ["a.md", "b.md", "c.md"],
	high: ["a.md"],
	medium: [],
	low: [],
};

let llmResponse: unknown = { content: '{"filenames":[],"reasoning":"none"}' };
let llmError: Error | null = null;
let catalogOverride: RunbookCatalogEntry[] | null = null;

function buildRuntime(): SelectRunbooksRuntime {
	return {
		getCatalog: () => catalogOverride ?? DEFAULT_CATALOG,
		getFallbackConfig: () => FALLBACK_CONFIG,
		getLlm: () => ({
			invoke: async () => {
				if (llmError) throw llmError;
				return llmResponse as { content: unknown };
			},
		}),
	};
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [new HumanMessage("test incident")],
		queryComplexity: "complex",
		targetDataSources: [],
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
		finalAnswer: "",
		dataSourceContext: undefined,
		requestId: "test",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: { severity: "critical" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		...overrides,
	} as AgentStateType;
}

describe("runSelectRunbooks", () => {
	beforeEach(() => {
		llmResponse = { content: '{"filenames":[],"reasoning":"none"}' };
		llmError = null;
		catalogOverride = null;
	});

	test("1. valid single pick", async () => {
		llmResponse = { content: '{"filenames":["a.md"],"reasoning":"pattern A"}' };
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
	});

	test("2. valid two picks", async () => {
		llmResponse = { content: '{"filenames":["a.md","b.md"],"reasoning":"both apply"}' };
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md"]);
	});

	test("3. valid empty", async () => {
		llmResponse = { content: '{"filenames":[],"reasoning":"nothing matches"}' };
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual([]);
	});

	test("4. partial validity drops invalid filename", async () => {
		llmResponse = {
			content: '{"filenames":["a.md","bogus.md"],"reasoning":"pattern A"}',
		};
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
	});

	test("5. all invalid filenames triggers fallback", async () => {
		llmResponse = { content: '{"filenames":["bogus.md"],"reasoning":"pattern A"}' };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "critical" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
	});

	test("6. malformed JSON triggers fallback", async () => {
		llmResponse = { content: "not json" };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "critical" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
	});

	test("7. three returned are truncated to two", async () => {
		llmResponse = {
			content: '{"filenames":["a.md","b.md","c.md"],"reasoning":"all"}',
		};
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md"]);
	});

	test("8. timeout triggers medium fallback (empty)", async () => {
		const err = new Error("timeout");
		err.name = "TimeoutError";
		llmError = err;
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "medium" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual([]);
	});

	test("9. api error triggers low fallback (empty)", async () => {
		llmError = new Error("500 Internal Server Error");
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "low" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual([]);
	});

	test("10. missing severity + router fails throws RunbookSelectionFallbackError", async () => {
		llmError = new Error("api error");
		await expect(runSelectRunbooks(makeState({ normalizedIncident: {} }), buildRuntime())).rejects.toThrow(
			RunbookSelectionFallbackError,
		);
	});

	test("11. missing severity + router succeeds returns pick", async () => {
		llmResponse = { content: '{"filenames":["a.md"],"reasoning":"A"}' };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: {} }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
	});

	test("12. empty catalog skips router and leaves state unchanged", async () => {
		catalogOverride = [];
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		// Empty return means no selectedRunbooks field in the partial, so state stays null
		expect(result.selectedRunbooks).toBeUndefined();
	});

	test("13. high severity fallback returns single runbook", async () => {
		llmError = new Error("api error");
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "high" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
	});

	test("14. RunbookSelectionFallbackError message includes mode and guidance", async () => {
		llmError = new Error("api error");
		try {
			await runSelectRunbooks(makeState({ normalizedIncident: {} }), buildRuntime());
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(RunbookSelectionFallbackError);
			expect((err as Error).message).toContain("fallback.api_error");
			expect((err as Error).message).toContain("severity is missing");
		}
	});
});
