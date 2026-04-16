// packages/agent/src/runbook-selector.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { RunbookCatalogEntry } from "./prompt-context.ts";
import {
	matchMetricsAxis,
	matchServicesAxis,
	matchSeverityAxis,
	matchTriggers,
	narrowCatalogByTriggers,
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
		targetDeployments: [],
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

describe("matchSeverityAxis", () => {
	test("severity in allowed list", () => {
		expect(matchSeverityAxis(["critical", "high"], "critical")).toBe(true);
	});

	test("severity not in list", () => {
		expect(matchSeverityAxis(["critical"], "low")).toBe(false);
	});

	test("severity undefined", () => {
		expect(matchSeverityAxis(["critical"], undefined)).toBe(false);
	});
});

describe("matchServicesAxis", () => {
	test("pattern is substring of service name", () => {
		expect(matchServicesAxis(["kafka"], [{ name: "kafka-broker" }])).toBe(true);
	});

	test("case-insensitive", () => {
		expect(matchServicesAxis(["KAFKA"], [{ name: "kafka-broker" }])).toBe(true);
	});

	test("no match", () => {
		expect(matchServicesAxis(["kafka"], [{ name: "auth-api" }])).toBe(false);
	});

	test("undefined affected services", () => {
		expect(matchServicesAxis(["kafka"], undefined)).toBe(false);
	});

	test("empty affected services array", () => {
		expect(matchServicesAxis(["kafka"], [])).toBe(false);
	});

	test("multiple patterns, any match wins", () => {
		expect(matchServicesAxis(["kafka", "consumer"], [{ name: "user-consumer" }])).toBe(true);
	});
});

describe("matchMetricsAxis", () => {
	test("pattern is substring of metric name", () => {
		expect(matchMetricsAxis(["lag"], [{ name: "consumer_lag" }])).toBe(true);
	});

	test("no match", () => {
		expect(matchMetricsAxis(["lag"], [{ name: "latency" }])).toBe(false);
	});

	test("undefined metrics", () => {
		expect(matchMetricsAxis(["lag"], undefined)).toBe(false);
	});
});

describe("matchTriggers combinator", () => {
	test("any: severity matches, services declared but no data", () => {
		const triggers = { severity: ["critical" as const], services: ["kafka"] };
		const incident = { severity: "critical" as const };
		expect(matchTriggers(triggers, incident)).toBe(true);
	});

	test("any: neither axis matches", () => {
		const triggers = { severity: ["critical" as const], services: ["kafka"] };
		const incident = { severity: "low" as const };
		expect(matchTriggers(triggers, incident)).toBe(false);
	});

	test("all: both declared axes match", () => {
		const triggers = {
			severity: ["critical" as const],
			services: ["kafka"],
			match: "all" as const,
		};
		const incident = {
			severity: "critical" as const,
			affectedServices: [{ name: "kafka-broker" }],
		};
		expect(matchTriggers(triggers, incident)).toBe(true);
	});

	test("all: one axis matches, other doesn't", () => {
		const triggers = {
			severity: ["critical" as const],
			services: ["kafka"],
			match: "all" as const,
		};
		const incident = {
			severity: "critical" as const,
			affectedServices: [{ name: "auth-api" }],
		};
		expect(matchTriggers(triggers, incident)).toBe(false);
	});

	test("all: one axis matches, other has no data", () => {
		const triggers = {
			severity: ["critical" as const],
			services: ["kafka"],
			match: "all" as const,
		};
		const incident = { severity: "critical" as const };
		expect(matchTriggers(triggers, incident)).toBe(false);
	});

	test("no axes declared (only match combinator)", () => {
		const triggers = { match: "any" as const };
		const incident = { severity: "critical" as const };
		expect(matchTriggers(triggers, incident)).toBe(false);
	});

	test("default combinator when match is undefined", () => {
		const triggers = { severity: ["critical" as const] };
		const incident = { severity: "critical" as const };
		expect(matchTriggers(triggers, incident)).toBe(true);
	});
});

describe("narrowCatalogByTriggers", () => {
	const entry = (filename: string, triggers?: RunbookCatalogEntry["triggers"]): RunbookCatalogEntry => ({
		filename,
		title: `Title of ${filename}`,
		summary: `Summary of ${filename}`,
		triggers,
	});

	test("noop: no runbook has triggers", () => {
		const catalog = [entry("a.md"), entry("b.md"), entry("c.md")];
		const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
		expect(result.mode).toBe("noop");
		expect(result.narrowed).toEqual(catalog);
	});

	test("narrowed: one trigger-declared runbook matches", () => {
		const catalog = [
			entry("a.md", { severity: ["critical"] }),
			entry("b.md", { severity: ["low"] }),
			entry("c.md", { severity: ["high"] }),
		];
		const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
		expect(result.mode).toBe("narrowed");
		expect(result.narrowed).toHaveLength(1);
		expect(result.narrowed[0]?.filename).toBe("a.md");
	});

	test("narrowed: multiple trigger-declared runbooks match", () => {
		const catalog = [
			entry("a.md", { severity: ["critical", "high"] }),
			entry("b.md", { severity: ["low"] }),
			entry("c.md", { severity: ["critical"] }),
		];
		const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
		expect(result.mode).toBe("narrowed");
		expect(result.narrowed).toHaveLength(2);
		expect(result.narrowed.map((e) => e.filename).sort()).toEqual(["a.md", "c.md"]);
	});

	test("fallback: all runbooks have triggers, none match", () => {
		const catalog = [
			entry("a.md", { severity: ["critical"] }),
			entry("b.md", { severity: ["high"] }),
			entry("c.md", { severity: ["medium"] }),
		];
		const result = narrowCatalogByTriggers(catalog, { severity: "low" });
		expect(result.mode).toBe("fallback");
		expect(result.narrowed).toEqual(catalog);
	});

	test("narrowed: mixed catalog, one trigger match + trigger-less pass", () => {
		const catalog = [
			entry("a.md", { severity: ["critical"] }),
			entry("b.md"), // trigger-less
			entry("c.md"), // trigger-less
		];
		const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
		expect(result.mode).toBe("narrowed");
		expect(result.narrowed).toHaveLength(3);
		expect(result.narrowed.map((e) => e.filename).sort()).toEqual(["a.md", "b.md", "c.md"]);
	});

	test("fallback: mixed catalog, trigger-declared doesn't match", () => {
		const catalog = [
			entry("a.md", { severity: ["critical"] }),
			entry("b.md"), // trigger-less
			entry("c.md"), // trigger-less
		];
		const result = narrowCatalogByTriggers(catalog, { severity: "low" });
		expect(result.mode).toBe("fallback");
		expect(result.narrowed).toHaveLength(3);
		expect(result.narrowed).toEqual(catalog);
	});

	test("noop: empty catalog (defensive)", () => {
		const result = narrowCatalogByTriggers([], { severity: "critical" });
		expect(result.mode).toBe("noop");
		expect(result.narrowed).toEqual([]);
	});
});

describe("runSelectRunbooks: trigger filter integration", () => {
	function buildRuntimeWithCatalog(
		catalog: RunbookCatalogEntry[],
		capturedPrompt: { value: string },
	): SelectRunbooksRuntime {
		return {
			getCatalog: () => catalog,
			getFallbackConfig: () => ({
				critical: [],
				high: [],
				medium: [],
				low: [],
			}),
			getLlm: () => ({
				invoke: async (messages: Array<{ role: string; content: string }>) => {
					capturedPrompt.value = messages.map((m) => m.content).join("\n");
					return { content: '{"filenames":[],"reasoning":"mock"}' };
				},
			}),
		};
	}

	test("narrowed mode: LLM receives only matching runbooks plus trigger-less runbooks", async () => {
		const catalog: RunbookCatalogEntry[] = [
			{
				filename: "match-a.md",
				title: "Match A",
				summary: "A",
				triggers: { severity: ["critical"] },
			},
			{
				filename: "match-b.md",
				title: "Match B",
				summary: "B",
				triggers: { severity: ["critical"] },
			},
			{
				filename: "nomatch.md",
				title: "No Match",
				summary: "X",
				triggers: { severity: ["low"] },
			},
			{ filename: "free-1.md", title: "Free 1", summary: "F1" },
			{ filename: "free-2.md", title: "Free 2", summary: "F2" },
		];
		const captured = { value: "" };
		const runtime = buildRuntimeWithCatalog(catalog, captured);
		const state = makeState({ normalizedIncident: { severity: "critical" } });

		await runSelectRunbooks(state, runtime);

		expect(captured.value).toContain("match-a.md");
		expect(captured.value).toContain("match-b.md");
		expect(captured.value).toContain("free-1.md");
		expect(captured.value).toContain("free-2.md");
		expect(captured.value).not.toContain("nomatch.md");
	});

	test("fallback mode: LLM receives full catalog when no trigger matches", async () => {
		const catalog: RunbookCatalogEntry[] = [
			{
				filename: "critical-only.md",
				title: "Crit",
				summary: "C",
				triggers: { severity: ["critical"] },
			},
			{
				filename: "high-only.md",
				title: "High",
				summary: "H",
				triggers: { severity: ["high"] },
			},
		];
		const captured = { value: "" };
		const runtime = buildRuntimeWithCatalog(catalog, captured);
		const state = makeState({ normalizedIncident: { severity: "low" } });

		await runSelectRunbooks(state, runtime);

		expect(captured.value).toContain("critical-only.md");
		expect(captured.value).toContain("high-only.md");
	});

	test("noop mode: no runbook has triggers, LLM receives full catalog", async () => {
		const catalog: RunbookCatalogEntry[] = [
			{ filename: "a.md", title: "A", summary: "A" },
			{ filename: "b.md", title: "B", summary: "B" },
			{ filename: "c.md", title: "C", summary: "C" },
		];
		const captured = { value: "" };
		const runtime = buildRuntimeWithCatalog(catalog, captured);
		const state = makeState({ normalizedIncident: { severity: "critical" } });

		await runSelectRunbooks(state, runtime);

		expect(captured.value).toContain("a.md");
		expect(captured.value).toContain("b.md");
		expect(captured.value).toContain("c.md");
	});
});
