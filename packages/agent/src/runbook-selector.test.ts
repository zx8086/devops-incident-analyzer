// packages/agent/src/runbook-selector.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { RunbookCatalogEntry } from "./prompt-context.ts";
import {
	filterCatalogByLifecycle,
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
		graphContext: "",
		graphBlastRadius: [],
		dataSourceContext: undefined,
		requestId: "test",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: { severity: "critical" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		confidencePreCap: undefined,
		capReasons: [] as string[],
		confirmedDegradingGapBullets: [] as string[],
		reportCaveats: [],
		rootCauseDataSources: undefined,
		degradedDataSources: [] as string[],
		confidenceCapMode: undefined,
		correlationFetchDirective: undefined,
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

	// SIO-746: max raised from 2 -> 3. Three picks now pass through untouched;
	// four-or-more are truncated to three.
	test("7. three returned pass through untouched", async () => {
		llmResponse = {
			content: '{"filenames":["a.md","b.md","c.md"],"reasoning":"all"}',
		};
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
	});

	test("7a. four returned are truncated to three", async () => {
		catalogOverride = [
			{ filename: "a.md", title: "Runbook A", summary: "Pattern A summary" },
			{ filename: "b.md", title: "Runbook B", summary: "Pattern B summary" },
			{ filename: "c.md", title: "Runbook C", summary: "Pattern C summary" },
			{ filename: "d.md", title: "Runbook D", summary: "Pattern D summary" },
		];
		llmResponse = {
			content: '{"filenames":["a.md","b.md","c.md","d.md"],"reasoning":"all"}',
		};
		const result = await runSelectRunbooks(makeState(), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
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

	// SIO-1287: end-to-end lifecycle behaviour through the node, not just the pure filter.
	test("15. a deprecated runbook is never offered to the LLM router", async () => {
		catalogOverride = [
			{ filename: "a.md", title: "A", summary: "sa" },
			{ filename: "b.md", title: "B", summary: "sb", status: "deprecated" },
		];
		// The router "picks" the deprecated file; it is not in validFilenames, so it cannot
		// be selected even if the model names it.
		llmResponse = { content: '{"filenames":["b.md"],"reasoning":"x"}' };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "high" } }), buildRuntime());
		expect(result.selectedRunbooks).not.toContain("b.md");
	});

	// The fallback reads filenames from index.yaml config, NOT from the catalog -- the one
	// route that bypasses every catalog-level filter. Without the explicit exclusion set, a
	// deprecated runbook would re-enter here.
	test("16. the severity fallback drops deprecated runbooks too", async () => {
		catalogOverride = [
			{ filename: "a.md", title: "A", summary: "sa", status: "deprecated" },
			{ filename: "b.md", title: "B", summary: "sb" },
			{ filename: "c.md", title: "C", summary: "sc" },
		];
		llmError = new Error("api error");
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "critical" } }), buildRuntime());
		// FALLBACK_CONFIG.critical is [a.md, b.md, c.md]; a.md is deprecated.
		expect(result.selectedRunbooks).toEqual(["b.md", "c.md"]);
	});

	// A past stale_after must NOT change selection -- it only warns (SIO-1287 decision).
	test("17. a stale-but-not-deprecated runbook stays selectable", async () => {
		catalogOverride = [{ filename: "a.md", title: "A", summary: "sa", staleAfter: "2020-01-01" }];
		llmResponse = { content: '{"filenames":["a.md"],"reasoning":"x"}' };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "high" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
	});

	// Guard: all-deprecated passes the full catalog through rather than starving the router.
	test("18. an all-deprecated catalog does not starve selection", async () => {
		catalogOverride = [
			{ filename: "a.md", title: "A", summary: "sa", status: "deprecated" },
			{ filename: "b.md", title: "B", summary: "sb", status: "deprecated" },
		];
		llmResponse = { content: '{"filenames":["a.md"],"reasoning":"x"}' };
		const result = await runSelectRunbooks(makeState({ normalizedIncident: { severity: "high" } }), buildRuntime());
		expect(result.selectedRunbooks).toEqual(["a.md"]);
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

// SIO-1287: OKF lifecycle filtering. `status: deprecated` is BINDING (an explicit human
// act); a past `stale_after` is ADVISORY (an author's months-old guess -- a mis-set date
// silently starving selection is worse than stale-but-present guidance).
describe("filterCatalogByLifecycle", () => {
	const NOW = new Date("2026-07-29T12:00:00Z");
	const lc = (filename: string, status?: RunbookCatalogEntry["status"], staleAfter?: string): RunbookCatalogEntry => ({
		filename,
		title: `Title of ${filename}`,
		summary: `Summary of ${filename}`,
		status,
		staleAfter,
	});

	test("noop: no runbook carries lifecycle fields (every runbook in the repo today)", () => {
		const catalog = [lc("a.md"), lc("b.md")];
		const result = filterCatalogByLifecycle(catalog, NOW);
		expect(result.mode).toBe("noop");
		// Returns the SAME array reference, so the no-lifecycle path is provably inert.
		expect(result.kept).toBe(catalog);
		expect(result.excluded).toEqual([]);
	});

	test("filtered: status deprecated is excluded", () => {
		const result = filterCatalogByLifecycle([lc("a.md"), lc("b.md", "deprecated"), lc("c.md")], NOW);
		expect(result.mode).toBe("filtered");
		expect(result.kept.map((e) => e.filename)).toEqual(["a.md", "c.md"]);
		expect(result.excluded).toEqual(["b.md"]);
	});

	test("status stable and draft are both kept (absent means stable per OKF)", () => {
		const result = filterCatalogByLifecycle([lc("a.md", "stable"), lc("b.md", "draft"), lc("c.md")], NOW);
		expect(result.mode).toBe("noop");
		expect(result.kept).toHaveLength(3);
	});

	test("emptied: every runbook deprecated -> full catalog passes through rather than starving", () => {
		const catalog = [lc("a.md", "deprecated"), lc("b.md", "deprecated")];
		const result = filterCatalogByLifecycle(catalog, NOW);
		expect(result.mode).toBe("emptied");
		expect(result.kept).toHaveLength(2);
		expect(result.excluded).toEqual(["a.md", "b.md"]);
	});

	test("past stale_after is ADVISORY: reported but NOT excluded", () => {
		const result = filterCatalogByLifecycle([lc("a.md", undefined, "2026-01-01"), lc("b.md")], NOW);
		expect(result.stale).toEqual(["a.md"]);
		expect(result.kept.map((e) => e.filename)).toEqual(["a.md", "b.md"]);
		expect(result.mode).toBe("noop");
	});

	test("future stale_after is not reported stale", () => {
		const result = filterCatalogByLifecycle([lc("a.md", undefined, "2027-01-01")], NOW);
		expect(result.stale).toEqual([]);
	});

	// Boundary: stale_after is a plain OKF YYYY-MM-DD with no time or zone, so it is
	// compared as a string. "expires ON this date" must not fire on the date itself.
	test("stale_after equal to today is NOT stale (boundary)", () => {
		const result = filterCatalogByLifecycle([lc("a.md", undefined, "2026-07-29")], NOW);
		expect(result.stale).toEqual([]);
	});

	test("stale_after one day before today IS stale (boundary)", () => {
		const result = filterCatalogByLifecycle([lc("a.md", undefined, "2026-07-28")], NOW);
		expect(result.stale).toEqual(["a.md"]);
	});

	test("a deprecated runbook that is ALSO stale is excluded once, and still reported stale", () => {
		const result = filterCatalogByLifecycle([lc("a.md", "deprecated", "2026-01-01"), lc("b.md")], NOW);
		expect(result.excluded).toEqual(["a.md"]);
		expect(result.stale).toEqual(["a.md"]);
		expect(result.kept.map((e) => e.filename)).toEqual(["b.md"]);
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

	// SIO-1293: trigger stems are matched as substrings of the normalizer's
	// HUMAN-PHRASED metric names ("consumer lag", not "consumer_lag"). These two
	// cases pin the contract the production runbook stems rely on.
	test("SIO-1293: human-phrased metric matches domain stems; trigger-less cross-cutting entry survives narrowing", () => {
		const catalog = [
			entry("kafka-consumer-lag.md", { metrics: ["lag", "dlq", "dead letter", "consumer", "kafka"] }),
			entry("high-error-rate.md", { metrics: ["error rate", "5xx", "http", "gateway", "ingest"] }),
			entry("code-change-correlation.md"), // trigger-less: always visible to the router
		];
		const result = narrowCatalogByTriggers(catalog, {
			extractedMetrics: [{ name: "consumer lag", value: "12000" }],
		});
		expect(result.mode).toBe("narrowed");
		expect(result.narrowed.map((e) => e.filename).sort()).toEqual([
			"code-change-correlation.md",
			"kafka-consumer-lag.md",
		]);
	});

	test("SIO-1293: ambiguous metric matches no domain stem -> fallback keeps the full catalog", () => {
		const catalog = [
			entry("kafka-consumer-lag.md", { metrics: ["lag", "dlq", "dead letter", "consumer", "kafka"] }),
			entry("high-error-rate.md", { metrics: ["error rate", "5xx", "http", "gateway", "ingest"] }),
			entry("code-change-correlation.md"),
		];
		const result = narrowCatalogByTriggers(catalog, {
			extractedMetrics: [{ name: "error count", value: "57" }],
		});
		expect(result.mode).toBe("fallback");
		expect(result.narrowed).toEqual(catalog);
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
