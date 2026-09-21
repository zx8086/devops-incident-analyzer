// agent/src/action-selector.test.ts
// SIO-1839. Injected ask; the response bodies are the shape a real jev-1.13.0
// call returned on 2026-09-20 ({type:"noul", noul} plus usage), captured before
// this file was written.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	getActionDescriptions,
	getActionKeywords,
	getAvailableActions,
	loadAgent,
	matchActionsByKeywords,
	type ToolDefinition,
	ToolDefinitionSchema,
} from "@devops-agent/gitagent-bridge";
import {
	ACTION_INCLUDE_THRESHOLD,
	type AskSystemOne,
	isActionSelectorEnabled,
	selectActions,
} from "./action-selector.ts";
import { buildSelectableActions } from "./sub-agent.ts";
import type { SystemOneResponse } from "./typesafe-client.ts";

// Two real datasource action sets, trimmed. The keyword lists are verbatim from
// agents/incident-analyzer/tools/*.yaml.
const KAFKA_ACTIONS: Record<string, string[]> = {
	dlq_messages: ["dead letter", "dlq"],
	describe_topic: ["partition", "topic layout", "describe topic"],
	consumer_lag: ["lag", "consumer group lag"],
	schema_registry: ["schema registry", "avro schema"],
};

/** The selection, or a failure the test did not expect. */
function sel(r: Awaited<ReturnType<typeof selectActions>>) {
	if (!r.ok) throw new Error(`expected a selection, got ${r.reason}`);
	return r.selection;
}

/** Answers by action name; anything unlisted scores 0. */
function askScoring(byName: Record<string, number>, names: string[]): { ask: AskSystemOne; sent: unknown[] } {
	const sent: unknown[] = [];
	const ask = (async (o: Parameters<AskSystemOne>[0]) => {
		sent.push(o);
		const answers: SystemOneResponse["answers"] = {};
		names.forEach((name, i) => {
			answers[`a${i}`] = { type: "noul", noul: byName[name] ?? 0 };
		});
		return { model: "jev-1.13.0", answers, usage: { input_tokens: 220, output_tokens: 40 } };
	}) as AskSystemOne;
	return { ask, sent };
}

// SIO-1839 follow-up: the selector must cover every datasource that declares
// actions, not only the three that also declare keywords. An mcp-tool-eval run
// caught this: the couchbase dispatch never logged a selection because the gate
// keyed off action_keywords, and couchbase-health.yaml has none. The feature was
// merged, wired in, gated open -- and inert for 4 of 7 datasources.
describe("coverage across the real tool definitions", () => {
	const TOOLS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

	test("every datasource with an action map is askable, keywords or not", () => {
		const agent = loadAgent(TOOLS_DIR);
		const withActions = agent.tools.filter((t) => getAvailableActions(t).length > 0);
		// Guard the guard: if this ever reads 0, the loader changed and the
		// assertions below would pass vacuously.
		expect(withActions.length).toBeGreaterThanOrEqual(7);

		// SIO-1864 closed the gap this originally pinned: every datasource now declares
		// keywords (72/72), so the old `noKeywords.length > 0` precondition is false by
		// design rather than by regression. The assertion below keeps the real guarantee
		// -- the selector asks about EVERY action -- which is what the SIO-1839 bug was
		// about; keyword presence was only ever the mechanism that exposed it.
		const noKeywords = withActions.filter((t) => Object.keys(getActionKeywords(t)).length === 0);
		expect(noKeywords).toEqual([]);

		// buildSelectableActions is the PRODUCTION gate, called here rather than
		// re-implemented. The first version of this test rebuilt the map itself and
		// checked only its key count, so reverting the gate to the keyword-keyed
		// version left all 12 tests green (Greptile PR #873).
		for (const toolDef of withActions) {
			const asked = buildSelectableActions(toolDef);
			expect(Object.keys(asked).sort()).toEqual(getAvailableActions(toolDef).sort());
		}

		// The sharp end: a keywordless datasource must still be fully askable. No real
		// tool is keywordless since SIO-1864, so this uses a synthetic definition rather
		// than deleting the case -- a new datasource added without keywords must not
		// bring the SIO-1839 inertness back.
		const keywordless = ToolDefinitionSchema.parse({
			name: "keywordless-fixture",
			description: "a datasource that declares actions and no keywords",
			input_schema: { type: "object", properties: {}, required: [] },
			tool_mapping: {
				mcp_server: "fixture",
				mcp_patterns: ["fixture_*"],
				action_tool_map: { alpha: ["fixture_alpha"], beta: ["fixture_beta"] },
			},
		});
		const asked = buildSelectableActions(keywordless);
		expect(Object.keys(asked).sort()).toEqual(["alpha", "beta"]);
		// ...and every one of its actions carries an array, not a missing entry, so the
		// question builder has something to iterate.
		expect(Object.values(asked).every((k) => Array.isArray(k))).toBe(true);
	});
});

// SIO-1864: the description is the FIRST entry, ahead of any keywords. All seven
// incident-analyzer tools declare `action_descriptions` ("pick this action when ...")
// while only 20 of 72 actions declare keywords, so without this the model was asked
// about a bare identifier for 52 actions while a precise description sat unused in the
// same YAML.
//
// Measured live on the couchbase set, query "the Capella cluster is reporting fatal
// query errors and timeouts": with bare identifiers `fatal_requests` did not reach the
// top four and `search_analysis` (FTS, irrelevant) was selected at 0.61; with the
// description `fatal_requests` became the top pick at 0.88 and the FTS noise dropped.
describe("SIO-1864: action_descriptions reach the selector", () => {
	const INCIDENT_ANALYZER_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

	function toolsWithActions(): ToolDefinition[] {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		return agent.tools.filter((t) => getAvailableActions(t).length > 0);
	}

	test("every action with a description carries it as the first entry", () => {
		const defs = toolsWithActions();
		let checked = 0;
		for (const toolDef of defs) {
			const descriptions = getActionDescriptions(toolDef);
			const asked = buildSelectableActions(toolDef);
			for (const [action, description] of Object.entries(descriptions)) {
				const entries = asked[action];
				if (!entries) throw new Error(`${toolDef.name}: ${action} missing from the selectable map`);
				// First, so it leads the "It covers: ..." text the question builds.
				expect(entries[0]).toBe(description);
				checked++;
			}
		}
		// Pin the precondition: if the YAMLs ever stop declaring descriptions this test
		// would pass vacuously while the regression it guards became reachable again.
		expect(checked).toBeGreaterThan(50);
	});

	test("keywords are kept as additional context, not replaced", () => {
		// kafka declares BOTH a description and keywords for dlq_messages, so it proves
		// the two are combined rather than one overwriting the other.
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		if (!kafka) throw new Error("kafka-introspect not found");
		const keywords = getActionKeywords(kafka).dlq_messages;
		const description = getActionDescriptions(kafka).dlq_messages;
		if (!keywords?.length || !description) throw new Error("expected dlq_messages to declare both");

		const entries = buildSelectableActions(kafka).dlq_messages ?? [];
		expect(entries[0]).toBe(description);
		for (const kw of keywords) expect(entries).toContain(kw);
	});

	test("an action with no description still yields an array the question builder can iterate", () => {
		const defs = toolsWithActions();
		for (const toolDef of defs) {
			const descriptions = getActionDescriptions(toolDef);
			const asked = buildSelectableActions(toolDef);
			for (const action of getAvailableActions(toolDef)) {
				if (descriptions[action]) continue;
				expect(Array.isArray(asked[action])).toBe(true);
			}
		}
	});
});

// SIO-1864: every action now declares keywords (72/72, up from 20/72). The phrasing is
// sourced from the DEVOPS-1354 "Agentic Investigations" epic -- 33 incident reports this
// agent produced -- not invented from the action names.
//
// Keywords are not interchangeable with action_descriptions: descriptions only shape the
// Jev question, while keywords drive matchActionsByKeywords AND the high-precision
// ranking tier that sits above Jev scores in the tool budget (Greptile P1, PR #875).
describe("SIO-1864: action_keywords coverage", () => {
	const INCIDENT_ANALYZER_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

	test("every action of every tool declares at least one keyword", () => {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const withActions = agent.tools.filter((t) => getAvailableActions(t).length > 0);
		expect(withActions.length).toBeGreaterThanOrEqual(7);

		const gaps: string[] = [];
		let total = 0;
		for (const toolDef of withActions) {
			const keywords = getActionKeywords(toolDef);
			for (const action of getAvailableActions(toolDef)) {
				total++;
				if (!keywords[action]?.length) gaps.push(`${toolDef.name}.${action}`);
			}
		}
		// Named, so a YAML edit that empties one set says WHICH one rather than a bare count.
		expect(gaps).toEqual([]);
		expect(total).toBeGreaterThanOrEqual(72);
	});

	// Greptile PR #878 (P1): a keyword ending in a non-word character can NEVER match,
	// because matchActionsByKeywords builds \b<kw>\b and the trailing \b requires a word
	// character on its left. "sql++" was exactly that -- "run a SQL++ query" returned [].
	// A dead keyword is worse than a missing one: it reads as coverage while the action
	// silently never reaches the high-precision tier.
	test("no keyword is unmatchable because it starts or ends with a non-word character", () => {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const dead: string[] = [];
		for (const toolDef of agent.tools) {
			for (const [action, kws] of Object.entries(getActionKeywords(toolDef))) {
				for (const kw of kws) {
					// Probe the real matcher rather than re-deriving the regex: a keyword that
					// cannot match its own text is unmatchable by construction.
					if (!matchActionsByKeywords(kw, toolDef).includes(action)) {
						dead.push(`${toolDef.name}.${action}: ${JSON.stringify(kw)}`);
					}
				}
			}
		}
		expect(dead).toEqual([]);
	});

	// Phrase matching is ORDER-SENSITIVE and adjacency-sensitive, which is easy to get
	// wrong when writing keywords by hand. Three real eval-dataset queries matched nothing
	// on the first pass: "capella cluster health" missed "health of the Couchbase Capella
	// cluster" (word order), and "logs for" missed "logs on eu-b2b for the ... service" (an
	// interposed clause). These are the queries the mcp-tool-eval actually runs, so a
	// keyword edit that breaks one of them breaks a measured example.
	test("the eval dataset queries keyword-match their datasource", () => {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const cases: Array<[string, string, string]> = [
			[
				"couchbase-cluster-health",
				"What is the current health of the Couchbase Capella cluster hosting the default bucket",
				"system_vitals",
			],
			[
				"couchbase-cluster-health",
				"Give me a full query-performance profile of the Couchbase cluster behind the default bucket",
				"expensive_queries",
			],
			[
				"elastic-search-logs",
				"Search the last 24 hours of logs on eu-b2b for the pvh-services-styles-v3 service and report the error volume",
				"search",
			],
			[
				"elastic-search-logs",
				"What is the current cluster health of the eu-b2b deployment? Report status, node count, and any unassigned shards",
				"cluster_health",
			],
			[
				"kafka-introspect",
				"Describe the c72-shared-services-msk Kafka cluster: how many brokers are there and what is the controller?",
				"cluster_info",
			],
			["kafka-introspect", "List the consumer groups and report which ones are showing meaningful lag", "consumer_lag"],
			[
				"gitlab-api",
				"List the most recent merge requests in GitLab project 43242609 and summarise what changed",
				"merge_requests",
			],
			[
				"atlassian-api",
				"Search Jira for recent incident tickets and summarise the most recent few",
				"incident_correlation",
			],
			[
				"konnect-api-gateway",
				"List the services configured in Kong Konnect and report their upstream targets",
				"service_config",
			],
		];
		const misses: string[] = [];
		for (const [toolName, query, expected] of cases) {
			const toolDef = agent.tools.find((t) => t.name === toolName);
			if (!toolDef) throw new Error(`${toolName} not found`);
			const matched = matchActionsByKeywords(query, toolDef);
			if (!matched.includes(expected))
				misses.push(`${toolName}: expected ${expected}, got [${matched}] for "${query.slice(0, 50)}..."`);
		}
		// Named, so a broken keyword says WHICH query it broke.
		expect(misses).toEqual([]);
	});

	test("no keyword is claimed by two actions of the same tool", () => {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const collisions: string[] = [];
		for (const toolDef of agent.tools) {
			const owner = new Map<string, string>();
			for (const [action, kws] of Object.entries(getActionKeywords(toolDef))) {
				for (const kw of kws) {
					const key = kw.toLowerCase();
					const prev = owner.get(key);
					// A shared keyword makes the deterministic pass ambiguous: both actions
					// force-include, which is the over-selection the budget then has to cut.
					if (prev && prev !== action) collisions.push(`${toolDef.name}: "${kw}" on ${prev} and ${action}`);
					owner.set(key, action);
				}
			}
		}
		expect(collisions).toEqual([]);
	});

	test("real incident phrasing matches the right action, and boilerplate matches nothing", () => {
		const agent = loadAgent(INCIDENT_ANALYZER_DIR);
		const cb = agent.tools.find((t) => t.name === "couchbase-cluster-health");
		if (!cb) throw new Error("couchbase-cluster-health not found");

		// Phrasing lifted from DEVOPS-1407/1410/1412/1413 report bodies.
		expect(matchActionsByKeywords("The Capella cluster is reporting fatal query errors", cb)).toContain(
			"fatal_requests",
		);
		expect(matchActionsByKeywords("longest-running and most expensive queries", cb)).toContain("slow_queries");
		expect(matchActionsByKeywords("list system indexes and flag indexes to drop", cb)).toContain("index_analysis");

		// The negative that motivated dropping bare "scope"/"collection"/"bucket": this
		// header line appears in EVERY DEVOPS-14xx report and must match nothing.
		expect(
			matchActionsByKeywords(
				"AWS estates assessed: eu-oit-prd, eu-shared-services-prd - all findings are scoped to these two estates only",
				cb,
			),
		).toEqual([]);
	});
});

describe("isActionSelectorEnabled", () => {
	test("defaults ON, kill-switch only", () => {
		expect(isActionSelectorEnabled({})).toBe(true);
		expect(isActionSelectorEnabled({ ACTION_SELECTOR_ENABLED: "false" })).toBe(false);
		expect(isActionSelectorEnabled({ ACTION_SELECTOR_ENABLED: "0" })).toBe(false);
	});
});

describe("selectActions", () => {
	const names = Object.keys(KAFKA_ACTIONS);

	test("returns every action at or above the threshold", async () => {
		const { ask } = askScoring({ dlq_messages: 0.97, describe_topic: 0.91, consumer_lag: 0.2 }, names);
		const out = await selectActions("show me the DLQs and the topic's partition layout", KAFKA_ACTIONS, {
			apiKey: "k",
			ask,
		});
		expect(sel(out).actions.sort()).toEqual(["describe_topic", "dlq_messages"]);
	});

	test("the SIO-1398 dual-intent query keeps BOTH actions", async () => {
		// The documented failure of narrowOnHighPrecisionIntent: its drop-table
		// removed describe_topic whenever dlq_messages matched, so the tool was
		// never bound and the run scored 0.5 on expected_tools_fired twice. A
		// multi-label question cannot express that mistake -- the two answers are
		// independent.
		const { ask } = askScoring({ dlq_messages: 0.95, describe_topic: 0.88 }, names);
		const out = await selectActions("are there dead letter queues, and what is the partition layout", KAFKA_ACTIONS, {
			apiKey: "k",
			ask,
		});
		expect(sel(out).actions).toContain("dlq_messages");
		expect(sel(out).actions).toContain("describe_topic");
	});

	test("the threshold boundary is inclusive", async () => {
		const { ask } = askScoring({ consumer_lag: ACTION_INCLUDE_THRESHOLD }, names);
		const out = await selectActions("lag?", KAFKA_ACTIONS, { apiKey: "k", ask });
		expect(sel(out).actions).toEqual(["consumer_lag"]);
	});

	test("an all-low answer selects nothing rather than guessing", async () => {
		// An empty list is a real answer: the caller's own fallbacks (base actions,
		// keyword matches) still apply on top of it.
		const { ask } = askScoring({}, names);
		const out = await selectActions("hello", KAFKA_ACTIONS, { apiKey: "k", ask });
		expect(sel(out).actions).toEqual([]);
		expect(sel(out).scores.dlq_messages).toBe(0);
	});

	test("one missing answer voids the round as INCOMPLETE, not as a crash", async () => {
		// A partial belt reads as a considered selection while silently omitting
		// whatever went unanswered. The keyword pass is the better fallback.
		//
		// The reason matters, not just the failure: deleting the missing-answer
		// guard makes `answer.noul` throw a TypeError straight into the catch, so
		// an outcome-only assertion passes either way. Asserting "incomplete"
		// is what makes the guard load-bearing (verified: the mutation now fails).
		const ask = (async () => ({
			model: "jev-1.13.0",
			answers: { a0: { type: "noul" as const, noul: 0.9 } },
			usage: { input_tokens: 10, output_tokens: 2 },
		})) as AskSystemOne;
		expect(await selectActions("dlq?", KAFKA_ACTIONS, { apiKey: "k", ask })).toEqual({
			ok: false,
			reason: "incomplete",
		});
	});

	test("a Score answer where a Noul was asked voids the round", async () => {
		// The response is untrusted input; a wrong-shaped answer must not read as a
		// missing one and silently drop an action.
		const ask = (async () => ({
			model: "jev-1.13.0",
			answers: Object.fromEntries(
				Object.keys(KAFKA_ACTIONS).map((_, i) => [`a${i}`, { type: "score" as const, score: 2.9, confidence: 0.9 }]),
			),
			usage: { input_tokens: 10, output_tokens: 2 },
		})) as AskSystemOne;
		expect(await selectActions("dlq?", KAFKA_ACTIONS, { apiKey: "k", ask })).toEqual({
			ok: false,
			reason: "incomplete",
		});
	});

	test("a failed request reports ERROR, and never throws", async () => {
		const ask = (async () => {
			throw new Error("boom");
		}) as AskSystemOne;
		expect(await selectActions("dlq?", KAFKA_ACTIONS, { apiKey: "k", ask })).toEqual({ ok: false, reason: "error" });
	});

	test("no selection for an empty query or an empty action set", async () => {
		const { ask } = askScoring({}, names);
		for (const args of [["", KAFKA_ACTIONS] as const, ["   ", KAFKA_ACTIONS] as const, ["dlq?", {}] as const]) {
			const r = await selectActions(args[0], args[1], { apiKey: "k", ask });
			expect(r.ok).toBe(false);
		}
	});

	test("asks every action in ONE request, and names its keywords", async () => {
		// One round trip per dispatch is the whole latency argument. The keywords go
		// in because a bare identifier like `dlq_messages` is not a description.
		const { ask, sent } = askScoring({}, names);
		await selectActions("anything", KAFKA_ACTIONS, { apiKey: "k", ask });
		expect(sent).toHaveLength(1);
		const req = sent[0] as { questions: Record<string, { instructions: string }> };
		expect(Object.keys(req.questions)).toHaveLength(names.length);
		const dlq = Object.values(req.questions).find((q) => q.instructions.includes("dlq_messages"));
		expect(dlq?.instructions).toContain("dead letter");
	});

	test("reports model, tokens and per-action scores for the metrics row", async () => {
		const { ask } = askScoring({ dlq_messages: 0.97 }, names);
		const out = await selectActions("dlq?", KAFKA_ACTIONS, { apiKey: "k", ask });
		expect(sel(out).model).toBe("jev-1.13.0");
		expect(sel(out).inputTokens).toBe(220);
		expect(sel(out).scores.dlq_messages).toBeCloseTo(0.97, 6);
		expect(sel(out).scores.schema_registry).toBe(0);
	});
});
