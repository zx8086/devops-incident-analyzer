// agent/src/action-selector.test.ts
// SIO-1839. Injected ask; the response bodies are the shape a real jev-1.13.0
// call returned on 2026-09-20 ({type:"noul", noul} plus usage), captured before
// this file was written.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getActionKeywords, getAvailableActions, loadAgent } from "@devops-agent/gitagent-bridge";
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

		const noKeywords = withActions.filter((t) => Object.keys(getActionKeywords(t)).length === 0);
		// The bug's precondition, pinned: several real datasources have actions and
		// NO keywords. If that stops being true the test still holds, but the
		// regression it guards would no longer be reachable.
		expect(noKeywords.length).toBeGreaterThan(0);

		// buildSelectableActions is the PRODUCTION gate, called here rather than
		// re-implemented. The first version of this test rebuilt the map itself and
		// checked only its key count, so reverting the gate to the keyword-keyed
		// version left all 12 tests green (Greptile PR #873).
		for (const toolDef of withActions) {
			const asked = buildSelectableActions(toolDef);
			expect(Object.keys(asked).sort()).toEqual(getAvailableActions(toolDef).sort());
		}

		// The sharp end: a keywordless datasource must still be fully askable.
		const keywordless = noKeywords[0];
		if (!keywordless) throw new Error("expected at least one keywordless tool definition");
		const asked = buildSelectableActions(keywordless);
		expect(Object.keys(asked).length).toBeGreaterThan(0);
		// ...and every one of its actions carries an empty keyword list, not a
		// missing entry, so the question builder has something to iterate.
		expect(Object.values(asked).every((k) => Array.isArray(k))).toBe(true);
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
