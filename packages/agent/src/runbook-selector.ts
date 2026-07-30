// packages/agent/src/runbook-selector.ts
// SIO-640: Lazy runbook selection node. Runs between normalize and entityExtractor
// when knowledge/index.yaml contains a runbook_selection block. Asks the
// orchestrator LLM to pick 0-3 runbooks from the catalog and writes the
// selection to state.selectedRunbooks as a tri-state (null | [] | [names]).
// SIO-746: max picks raised from 2 -> 3 after cross-datasource incidents
// (Couchbase + Elastic APM + Kafka DLQs) consistently surfaced only one
// matched runbook even when 2-3 were applicable.

import type { RunbookTriggers } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { NormalizedIncident } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { parseLlmJson } from "./llm-json.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getAgent, getRunbookCatalog, type RunbookCatalogEntry } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:runbook-selector");

// Thrown when the LLM router fails AND the severity tier fallback cannot be
// consulted because state.normalizedIncident.severity is missing. Deliberate
// hard-fail: silent "use all runbooks" would hide real normalize bugs.
export class RunbookSelectionFallbackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunbookSelectionFallbackError";
	}
}

// Thrown at agent load time if selectRunbooks is wired into the graph but the
// loaded agent has no runbook_selection config. Opt-in all-or-nothing.
class RunbookSelectionConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunbookSelectionConfigError";
	}
}

// SIO-1221: both fields were bare and required, so a single `"reasoning": null` -- which an
// LLM emits routinely instead of omitting a field -- discarded the whole selection and fell
// through to fallback.parse_error. `reasoning` is only ever logged, so it must not be able
// to veto an otherwise-valid filename list.
const RunbookSelectionResponseSchema = z.object({
	filenames: z
		.array(z.string())
		.max(10)
		.nullish()
		.transform((v) => v ?? []),
	reasoning: z
		.union([z.string(), z.number(), z.null()])
		.optional()
		.transform((v) => (v === null || v === undefined ? "" : String(v))),
});

export type RunbookSelectionResponse = z.infer<typeof RunbookSelectionResponseSchema>;

export type SelectionMode =
	| "llm"
	| "llm.partial"
	| "llm.empty"
	| "llm.truncated"
	| "fallback.parse_error"
	| "fallback.timeout"
	| "fallback.api_error"
	| "fallback.invalid_filenames"
	| "skip.empty_catalog"
	| "error.missing_severity";

// SIO-1302: source of a runbook filename in the final selection, distinct from
// SelectionMode (which describes HOW the router-picks half was resolved). Logged
// alongside mode so "code-change-correlation.md always present" is auditable
// without re-deriving it from the always-select config at log-read time.
export type SelectionSource = "router" | "fallback" | "always_select";

export type SeverityFallbackConfig = Record<"critical" | "high" | "medium" | "low", string[]>;

export interface RunbookSelectorDeps {
	catalog: RunbookCatalogEntry[];
	fallbackBySeverity: SeverityFallbackConfig;
}

// Minimal LLM interface the selector needs. Both ChatBedrockConverse and the
// test fake satisfy this shape, so no @langchain/aws mock is required at the
// test layer.
interface SelectorLlm {
	invoke(messages: Array<{ role: string; content: string }>, config?: RunnableConfig): Promise<{ content: unknown }>;
}

// Internal dependency bundle. Tests pass fakes via the second overload; the
// real LangGraph wiring uses createSelectRunbooksNode() to bind production
// deps at graph build time. This sidesteps the sibling-module mock leak
// problem that bit Task 5/6 by not requiring any module-level mocks of
// ./llm.ts, ./prompt-context.ts, or @devops-agent/gitagent-bridge.
export interface SelectRunbooksRuntime {
	getCatalog: () => RunbookCatalogEntry[];
	getFallbackConfig: () => SeverityFallbackConfig;
	getLlm: () => SelectorLlm;
	// SIO-1302: filenames appended to every selection unconditionally (router
	// picks AND severity fallback), deduped. Optional so existing callers that
	// predate this field behave as if it returned []; createSelectRunbooksNode
	// wires it to agent.runbookSelection.always_select.
	getAlwaysSelect?: () => string[];
}

export async function runSelectRunbooks(
	state: AgentStateType,
	runtime: SelectRunbooksRuntime,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const startTime = Date.now();
	const fullCatalog = runtime.getCatalog();

	// Step 1: empty catalog -> skip router, leave state unchanged
	if (fullCatalog.length === 0) {
		logger.info({ mode: "skip.empty_catalog", catalogSize: 0 }, "Runbook catalog is empty; skipping selection");
		return {};
	}

	// SIO-1287: Lifecycle filter runs FIRST, so a deprecated runbook is gone before triggers
	// are considered and before the severity fallback can reinstate it.
	const lifecycleResult = filterCatalogByLifecycle(fullCatalog, new Date());
	if (lifecycleResult.mode !== "noop") {
		logger.info(
			{
				lifecycle_filter_mode: lifecycleResult.mode,
				lifecycle_excluded: lifecycleResult.excluded,
				lifecycle_input_size: fullCatalog.length,
				lifecycle_output_size: lifecycleResult.kept.length,
			},
			lifecycleResult.mode === "emptied"
				? "Runbook lifecycle filter: EVERY runbook is deprecated; passing the full catalog through rather than starving selection"
				: `Runbook lifecycle filter: excluded ${lifecycleResult.excluded.length} deprecated runbook(s)`,
		);
	}
	// Advisory per the SIO-1287 decision: a past stale_after warns but does NOT exclude. The
	// date is an author's months-old guess, and a mis-set one silently starving selection is
	// worse than stale-but-present guidance.
	if (lifecycleResult.stale.length > 0) {
		logger.warn(
			{ stale_runbooks: lifecycleResult.stale },
			`${lifecycleResult.stale.length} runbook(s) past stale_after; still selectable -- review them`,
		);
	}

	// SIO-643: Pre-filter via trigger grammar before the LLM router sees the catalog.
	// Triggers narrow, they do not gatekeep: zero matches -> full catalog fallback;
	// no runbook has triggers -> noop. The filter can only reduce the router's work.
	const incident = state.normalizedIncident ?? {};
	const filterResult = narrowCatalogByTriggers(lifecycleResult.kept, incident);
	const catalog = filterResult.narrowed;

	logger.info(
		{
			trigger_filter_mode: filterResult.mode,
			// SIO-1287: the trigger filter's input is now the lifecycle-filtered set, not the
			// raw catalog. Reporting fullCatalog.length here would misattribute lifecycle
			// exclusions to the trigger filter.
			trigger_filter_input_size: lifecycleResult.kept.length,
			trigger_filter_output_size: catalog.length,
		},
		`Runbook trigger filter: ${filterResult.mode}`,
	);

	const validFilenames = new Set(catalog.map((e) => e.filename));
	// SIO-1287: the severity fallback reads filenames from index.yaml config rather than from
	// the catalog, so it needs the exclusion set explicitly or deprecated entries re-enter there.
	const deprecatedFilenames = new Set(lifecycleResult.excluded);
	const severity = state.normalizedIncident?.severity;
	const fallbackConfig = runtime.getFallbackConfig();

	// SIO-1302: always-select filenames, validated against the LIFECYCLE-filtered
	// catalog (not the trigger-narrowed `catalog`/`validFilenames`) -- trigger
	// narrowing exists to reduce the LLM router's candidate list, not to gate a
	// deterministic injection that bypasses the router entirely. A deprecated
	// runbook is still never force-selected (same discipline as the severity
	// fallback below). An always-select filename absent from the lifecycle-kept
	// catalog entirely (e.g. a config typo) is dropped silently at this layer --
	// manifest-loader.ts already fails the agent load if it doesn't exist on disk
	// at all, so this is defense against a load-time-valid-but-now-deprecated file.
	const lifecycleKeptFilenames = new Set(lifecycleResult.kept.map((e) => e.filename));
	const alwaysSelect = (runtime.getAlwaysSelect?.() ?? []).filter((f) => lifecycleKeptFilenames.has(f));

	// Step 2: build router prompt
	const lastMessage = state.messages.at(-1);
	const rawInput = lastMessage ? extractTextFromContent(lastMessage.content).slice(0, 500) : "";
	const incidentSummary = formatIncidentSummary(state);
	const catalogBlock = catalog.map((e) => `  - ${e.filename}: ${e.title} -- ${e.summary}`).join("\n");

	const systemPrompt = `You are selecting operational runbooks for a DevOps incident investigation.
Pick 0 to 3 runbooks from the catalog that best match the incident. Cross-
datasource incidents (e.g. database + messaging + APM) often warrant 2-3
runbooks. If no runbook clearly applies, return an empty list. Do not guess.`;

	const userPrompt = `Incident summary:
${incidentSummary}
  raw input: ${rawInput}

Available runbooks:
${catalogBlock}

Return a JSON object matching this exact shape:
{"filenames": ["name1.md", "name2.md", "name3.md"], "reasoning": "one sentence"}

Rules:
- Pick 0 to 3 filenames. Include every runbook that clearly applies; do not
  artificially prefer 1 if the incident spans multiple datasources.
- Return empty filenames if no runbook clearly applies.
- filenames must exactly match the list above. Do not invent new names.`;

	// Step 3: invoke the LLM
	const llm = runtime.getLlm();
	let response: { content: unknown };
	try {
		response = await llm.invoke(
			[
				{ role: "system", content: systemPrompt },
				{ role: "human", content: userPrompt },
			],
			config,
		);
	} catch (err) {
		const isTimeout = err instanceof Error && err.name === "TimeoutError";
		const mode: SelectionMode = isTimeout ? "fallback.timeout" : "fallback.api_error";
		return enterFallback(mode, severity, fallbackConfig, startTime, deprecatedFilenames, alwaysSelect);
	}

	// Step 4: parse response
	const text = extractTextFromContent((response as { content: unknown }).content);
	const result = parseLlmJson(text, RunbookSelectionResponseSchema);
	if (!result.ok) {
		logger.warn({ reason: result.reason, detail: result.message }, "Runbook selection JSON unusable");
		return enterFallback(
			"fallback.parse_error",
			severity,
			fallbackConfig,
			startTime,
			deprecatedFilenames,
			alwaysSelect,
		);
	}
	const parsed: RunbookSelectionResponse = result.data;

	// Step 5: validate filenames against the catalog
	const validPicks = parsed.filenames.filter((f) => validFilenames.has(f));
	const invalidPicks = parsed.filenames.filter((f) => !validFilenames.has(f));

	if (parsed.filenames.length > 0 && validPicks.length === 0) {
		return enterFallback(
			"fallback.invalid_filenames",
			severity,
			fallbackConfig,
			startTime,
			deprecatedFilenames,
			alwaysSelect,
		);
	}

	// Step 6: truncate to max 3 (SIO-746 -- was 2)
	const truncated = validPicks.slice(0, 3);
	let mode: SelectionMode = "llm";
	if (parsed.filenames.length > 3) mode = "llm.truncated";
	else if (invalidPicks.length > 0) mode = "llm.partial";
	else if (truncated.length === 0) mode = "llm.empty";

	// SIO-1302: always-select rides ON TOP of the 3-pick cap, deduped against the
	// router's picks -- it is not subject to truncation and does not compete for
	// the router's 3 slots.
	const finalSelection = [...truncated, ...alwaysSelect.filter((f) => !truncated.includes(f))];

	logger.info(
		{
			mode,
			count: truncated.length,
			filenames: truncated.join(","),
			reasoning: parsed.reasoning,
			latencyMs: Date.now() - startTime,
			catalogSize: catalog.length,
			...(alwaysSelect.length > 0 ? { always_select: alwaysSelect.join(",") } : {}),
		},
		"Runbook selection complete",
	);

	return { selectedRunbooks: finalSelection };
}

// SIO-1287: `deprecated` is the set of filenames the lifecycle filter excluded. The severity
// fallback reads filenames straight from index.yaml config, NOT from the catalog, so without
// this a deprecated runbook would re-enter through the fallback path -- the one route that
// bypasses every catalog-level filter. A deprecated runbook is never a good answer, even when
// the alternative is an empty selection.
function enterFallback(
	mode: SelectionMode,
	severity: string | undefined,
	config: SeverityFallbackConfig,
	startTime: number,
	deprecated: ReadonlySet<string> = new Set(),
	alwaysSelect: string[] = [],
): Partial<AgentStateType> {
	if (!severity) {
		logger.error(
			{ mode: "error.missing_severity", latencyMs: Date.now() - startTime },
			"Runbook selection fallback required but severity is missing",
		);
		throw new RunbookSelectionFallbackError(
			`Runbook selector fallback required (${mode}) but state.normalizedIncident.severity is missing. ` +
				`This indicates a bug in the normalize node or a malformed incident; refusing to guess.`,
		);
	}
	const configured = config[severity as keyof SeverityFallbackConfig] ?? [];
	const fallback = configured.filter((f) => !deprecated.has(f));
	const dropped = configured.filter((f) => deprecated.has(f));
	// SIO-1302: always-select is unioned into the fallback path too, deduped --
	// the router failing must not lose the mandatory code-change frame either.
	const finalSelection = [...fallback, ...alwaysSelect.filter((f) => !fallback.includes(f))];
	logger.info(
		{
			mode,
			severity,
			filenames: fallback.join(","),
			count: fallback.length,
			...(dropped.length > 0 ? { lifecycle_dropped: dropped } : {}),
			...(alwaysSelect.length > 0 ? { always_select: alwaysSelect.join(",") } : {}),
			latencyMs: Date.now() - startTime,
		},
		dropped.length > 0
			? `Runbook selection entered fallback path; dropped ${dropped.length} deprecated runbook(s) from the severity tier`
			: "Runbook selection entered fallback path",
	);
	return { selectedRunbooks: finalSelection };
}

function formatIncidentSummary(state: AgentStateType): string {
	const inc = state.normalizedIncident ?? {};
	const lines: string[] = [];
	lines.push(`  severity: ${inc.severity ?? "unspecified"}`);
	if (inc.timeWindow) {
		lines.push(`  time window: ${inc.timeWindow.from} to ${inc.timeWindow.to}`);
	}
	if (inc.affectedServices && inc.affectedServices.length > 0) {
		lines.push(`  affected services: ${inc.affectedServices.map((s) => s.name).join(", ")}`);
	}
	if (inc.extractedMetrics && inc.extractedMetrics.length > 0) {
		const metrics = inc.extractedMetrics
			.map((m) => `${m.name}${m.value ? `=${m.value}` : ""}${m.threshold ? ` (${m.threshold})` : ""}`)
			.join(", ");
		lines.push(`  extracted metrics: ${metrics}`);
	}
	return lines.join("\n");
}

// SIO-643: Per-axis matchers for the runbook trigger grammar. Each function
// is a pure predicate over one axis of NormalizedIncident. The combinator
// matchTriggers composes them based on the runbook's declared axes and its
// optional match mode (any | all, default any).

export function matchSeverityAxis(
	allowed: Array<"critical" | "high" | "medium" | "low">,
	incidentSeverity: NormalizedIncident["severity"],
): boolean {
	if (incidentSeverity === undefined) return false;
	return allowed.includes(incidentSeverity);
}

export function matchServicesAxis(patterns: string[], affected: NormalizedIncident["affectedServices"]): boolean {
	if (!affected || affected.length === 0) return false;
	const lowerNames = affected.map((s) => s.name.toLowerCase());
	return patterns.some((pattern) => {
		const lowerPattern = pattern.toLowerCase();
		return lowerNames.some((name) => name.includes(lowerPattern));
	});
}

export function matchMetricsAxis(patterns: string[], extracted: NormalizedIncident["extractedMetrics"]): boolean {
	if (!extracted || extracted.length === 0) return false;
	const lowerNames = extracted.map((m) => m.name.toLowerCase());
	return patterns.some((pattern) => {
		const lowerPattern = pattern.toLowerCase();
		return lowerNames.some((name) => name.includes(lowerPattern));
	});
}

export function matchTriggers(triggers: RunbookTriggers, incident: NormalizedIncident): boolean {
	const axisResults: boolean[] = [];

	if (triggers.severity !== undefined) {
		axisResults.push(matchSeverityAxis(triggers.severity, incident.severity));
	}
	if (triggers.services !== undefined) {
		axisResults.push(matchServicesAxis(triggers.services, incident.affectedServices));
	}
	if (triggers.metrics !== undefined) {
		axisResults.push(matchMetricsAxis(triggers.metrics, incident.extractedMetrics));
	}

	// No axes declared -> no match. Lint-level signal, not a crash.
	if (axisResults.length === 0) return false;

	const combinator = triggers.match ?? "any";
	return combinator === "all" ? axisResults.every((r) => r) : axisResults.some((r) => r);
}

// SIO-1287: Deterministic lifecycle pre-filter, applied BEFORE trigger narrowing so a
// deprecated runbook never reaches the LLM router regardless of whether it declares
// triggers -- and before the severity fallback, so it cannot re-enter that way either.
//
// Two signals, deliberately treated differently:
//   status: deprecated -> BINDING. An explicit human act saying "do not use this".
//   stale_after past   -> ADVISORY. A date guessed months earlier by an author; a mis-set
//                         one silently starving selection is worse than stale-but-present
//                         guidance, so it warns and KEEPS the entry.
// `status: draft` is kept: drafts are authored intentionally, and OKF's default for an
// absent status is `stable`, so absence is never a reason to exclude.
//
// Guard: if every entry is deprecated, return the full catalog rather than starving the
// router, and report `emptied` so the log distinguishes it from a genuine empty selection.
export function filterCatalogByLifecycle(
	catalog: RunbookCatalogEntry[],
	now: Date,
): { kept: RunbookCatalogEntry[]; mode: "noop" | "filtered" | "emptied"; excluded: string[]; stale: string[] } {
	const today = now.toISOString().slice(0, 10);
	// Compared as YYYY-MM-DD strings, not timestamps: `stale_after` is a plain OKF date
	// with no time or zone, so lexicographic comparison is exactly right and immune to the
	// off-by-a-day errors a Date round-trip would introduce.
	const stale = catalog.filter((e) => e.staleAfter !== undefined && e.staleAfter < today).map((e) => e.filename);
	const kept = catalog.filter((e) => e.status !== "deprecated");
	const excluded = catalog.filter((e) => e.status === "deprecated").map((e) => e.filename);

	if (excluded.length === 0) {
		return { kept: catalog, mode: "noop", excluded, stale };
	}
	if (kept.length === 0) {
		return { kept: catalog, mode: "emptied", excluded, stale };
	}
	return { kept, mode: "filtered", excluded, stale };
}

// SIO-643: Deterministic pre-filter that narrows the runbook catalog before
// the LLM router sees it. Three modes:
//   noop     - no runbook declared triggers; filter is inactive, pass-through.
//   narrowed - at least one trigger-declared runbook matched; the narrowed
//              set is matched runbooks plus all trigger-less runbooks
//              (trigger-less opts out of filtering, not out of the catalog).
//   fallback - every trigger-declared runbook failed to match; fall through
//              to the full catalog to avoid starving the LLM router.
export function narrowCatalogByTriggers(
	catalog: RunbookCatalogEntry[],
	incident: NormalizedIncident,
): { narrowed: RunbookCatalogEntry[]; mode: "noop" | "narrowed" | "fallback" } {
	const withTriggers = catalog.filter((e) => e.triggers !== undefined);
	const withoutTriggers = catalog.filter((e) => e.triggers === undefined);

	// No runbook has triggers: the filter is a no-op
	if (withTriggers.length === 0) {
		return { narrowed: catalog, mode: "noop" };
	}

	// biome-ignore lint/style/noNonNullAssertion: filter above guarantees triggers is defined
	const matched = withTriggers.filter((e) => matchTriggers(e.triggers!, incident));

	// Zero matches: fall through to the full catalog
	if (matched.length === 0) {
		return { narrowed: catalog, mode: "fallback" };
	}

	// Narrowed set = matched trigger-declared runbooks + all trigger-less runbooks
	return { narrowed: [...matched, ...withoutTriggers], mode: "narrowed" };
}

// Factory that binds production deps for the LangGraph wiring. Task 10 calls
// this from graph.ts. The returned node function satisfies LangGraph's
// node signature: (state, config) => Partial<state>. Throws
// RunbookSelectionConfigError at first-call time if the loaded agent has no
// runbook_selection block — this is the opt-in gate: wiring the node is
// only valid when the agent config actually has fallback tiers defined.
export function createSelectRunbooksNode(): (
	state: AgentStateType,
	config?: RunnableConfig,
) => Promise<Partial<AgentStateType>> {
	return async (state, config) => {
		const runtime: SelectRunbooksRuntime = {
			getCatalog: getRunbookCatalog,
			getFallbackConfig: () => {
				const agent = getAgent();
				if (!agent.runbookSelection) {
					throw new RunbookSelectionConfigError(
						"knowledge/index.yaml has no runbook_selection block but the runbook selector " +
							"is wired into the graph. Either remove the selectRunbooks node from graph.ts " +
							"or add a runbook_selection block with fallback_by_severity for all four severities.",
					);
				}
				return agent.runbookSelection.fallback_by_severity;
			},
			getLlm: () => createLlm("runbookSelector") as unknown as SelectorLlm,
			// SIO-1302: absent key in index.yaml -> [] (no always-select behavior),
			// matching the schema's optional() + the runtime interface's default.
			getAlwaysSelect: () => getAgent().runbookSelection?.always_select ?? [],
		};
		return runSelectRunbooks(state, runtime, config);
	};
}
