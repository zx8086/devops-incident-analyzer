// agent/src/sub-agent-truncation-synthesis.test.ts
//
// SIO-1260. The LLM is injected through `deps` rather than a module-global _setForTesting seam
// (the pattern gaps-judge and absence-judge use): the production caller already HAS the llm in
// scope, so parameter injection needs no afterEach reset and cannot pollute other suites -- this
// package has a documented history of exactly that (prompt-context mock bleed).

import { describe, expect, test } from "bun:test";
import type { InvokableLlm } from "./llm.ts";
import { shouldReserveFinalTurn } from "./sub-agent.ts";
import {
	buildTruncationEvidenceDigest,
	getSynthesisEvidenceBudgetBytes,
	isTruncationSynthesisEnabled,
	type SynthesisEvidenceEntry,
	type SynthesisInput,
	synthesizeTruncatedFindings,
} from "./sub-agent-truncation-synthesis.ts";

function fakeLlm(respond: () => unknown | Promise<unknown>): { llm: InvokableLlm; calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		llm: {
			invoke: async (messages: unknown) => {
				calls.push(messages);
				return { content: await respond() };
			},
		},
	};
}

const INPUT: SynthesisInput = {
	dataSourceId: "gitlab",
	trigger: "truncated",
	query: "Investigate pvh-services-styles-v3 RequestCanceledException",
	partialAnswer: "Let me check the repository tree.",
	evidence: [{ toolName: "gitlab_search", content: '[{"id":123,"path_with_namespace":"pvhcorp/b2b/styles"}]' }],
	toolErrorCount: 0,
};

describe("SIO-1260: buildTruncationEvidenceDigest", () => {
	test("under budget, every distinct tool appears and nothing is dropped", () => {
		const evidence: SynthesisEvidenceEntry[] = [
			{ toolName: "gitlab_search", content: '[{"id":1}]' },
			{ toolName: "gitlab_list_commits", content: '[{"sha":"abc"}]' },
			{ toolName: "gitlab_get_file_content", content: "export const a = 1;" },
		];
		const digest = buildTruncationEvidenceDigest(evidence, 48_000);
		expect(digest.entriesIncluded).toBe(3);
		expect(digest.entriesTotal).toBe(3);
		expect(digest.droppedTools).toEqual([]);
		for (const e of evidence) expect(digest.text).toContain(`### ${e.toolName}`);
	});

	// The breadth invariant: this is what pass 1 exists to guarantee. A depth-first fill would
	// spend the whole budget on the first fat tool and hide the others entirely.
	test("a tight budget still represents every distinct tool at least once", () => {
		const big = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ i, blob: "x".repeat(80) })));
		const evidence: SynthesisEvidenceEntry[] = [
			{ toolName: "gitlab_semantic_code_search", content: big },
			{ toolName: "gitlab_semantic_code_search", content: big },
			{ toolName: "gitlab_list_commits", content: big },
			{ toolName: "gitlab_pipeline_failures", content: big },
		];
		const budget = 8_000;
		const digest = buildTruncationEvidenceDigest(evidence, budget);
		expect(digest.includedTools.sort()).toEqual([
			"gitlab_list_commits",
			"gitlab_pipeline_failures",
			"gitlab_semantic_code_search",
		]);
		expect(digest.droppedTools).toEqual([]);
	});

	// Pins that truncateToolOutput was REUSED rather than a byte slice written: a slice would hand
	// the model invalid JSON and destroy the array shapes (the SIO-785/SIO-1159 failure mode).
	test("oversized JSON is truncated structurally, not byte-sliced", () => {
		const hits = Array.from({ length: 500 }, (_, i) => ({ _id: `doc-${i}`, msg: "y".repeat(50) }));
		const evidence: SynthesisEvidenceEntry[] = [
			{ toolName: "elasticsearch_search", content: JSON.stringify({ hits: { hits } }) },
		];
		const digest = buildTruncationEvidenceDigest(evidence, 4_000);
		const body = digest.text.split("\n").slice(1).join("\n");
		const parsed = JSON.parse(body) as { hits?: { hits?: unknown[] } };
		expect(Array.isArray(parsed.hits?.hits)).toBe(true);
		expect((parsed.hits?.hits ?? []).length).toBeLessThan(500);
		expect(digest.originalBytes).toBeGreaterThan(digest.bytes);
	});

	test("repeated calls to one tool are labelled and the LAST is kept first", () => {
		const evidence: SynthesisEvidenceEntry[] = [
			{ toolName: "gitlab_search", content: '{"call":1}' },
			{ toolName: "gitlab_search", content: '{"call":2}' },
			{ toolName: "gitlab_search", content: '{"call":3}' },
		];
		const digest = buildTruncationEvidenceDigest(evidence, 48_000);
		expect(digest.text).toContain("### gitlab_search (call 3 of 3)");
		expect(digest.entriesIncluded).toBe(3);
	});

	test("empty evidence yields an empty digest", () => {
		const digest = buildTruncationEvidenceDigest([], 48_000);
		expect(digest).toMatchObject({ text: "", entriesTotal: 0, entriesIncluded: 0 });
		expect(digest.includedTools).toEqual([]);
	});
});

describe("SIO-1260: synthesizeTruncatedFindings", () => {
	test("returns the synthesised report and feeds the model the evidence", async () => {
		const { llm, calls } = fakeLlm(() => "## Findings\nThe styles project is 123.");
		const result = await synthesizeTruncatedFindings(INPUT, { llm });
		expect(result?.text).toContain("The styles project is 123.");

		const messages = calls[0] as Array<{ content: unknown }>;
		const human = String(messages[1]?.content ?? "");
		expect(human).toContain(INPUT.query);
		expect(human).toContain("pvhcorp/b2b/styles");
		expect(human).toContain("Let me check the repository tree.");
	});

	// THE LOAD-BEARING TEST. If synthesis ever rejects, the throw escapes into runSubAgent's catch
	// and downgrades a salvaged partial success to a hard error -- destroying the evidence this
	// module exists to rescue.
	test("an LLM failure resolves to null and never rejects", async () => {
		const llm: InvokableLlm = {
			invoke: async () => {
				throw new Error("bedrock exploded");
			},
		};
		expect(await synthesizeTruncatedFindings(INPUT, { llm })).toBeNull();
	});

	// An aborted graph deadline must degrade, not propagate. gaps-judge deliberately RE-THROWS on an
	// external abort because it is advisory over an already-complete answer; here the same throw
	// would destroy a salvaged partial success, so this path must swallow it.
	test("an aborted signal resolves to null rather than propagating the abort", async () => {
		const llm: InvokableLlm = {
			invoke: async (_messages: unknown, config?: { signal?: AbortSignal }) => {
				if (config?.signal?.aborted) {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					throw err;
				}
				return { content: "unreachable" };
			},
		};
		const controller = new AbortController();
		controller.abort();
		expect(await synthesizeTruncatedFindings(INPUT, { llm, signal: controller.signal })).toBeNull();
	});

	// SIO-1222 class: a reasoning-first block array must yield the TEXT block, never "" and never
	// the reasoning.
	test("a reasoning-then-text block array returns only the text block", async () => {
		const { llm } = fakeLlm(() => [
			{ type: "reasoning", reasoningText: { text: "thinking out loud" } },
			{ type: "text", text: "REPORT BODY" },
		]);
		const result = await synthesizeTruncatedFindings(INPUT, { llm });
		expect(result?.text).toBe("REPORT BODY");
		expect(result?.text).not.toContain("thinking out loud");
	});

	test("whitespace-only content resolves to null", async () => {
		const { llm } = fakeLlm(() => "   \n  ");
		expect(await synthesizeTruncatedFindings(INPUT, { llm })).toBeNull();
	});

	test("empty evidence short-circuits before the LLM is called", async () => {
		const { llm, calls } = fakeLlm(() => "unused");
		const result = await synthesizeTruncatedFindings({ ...INPUT, evidence: [] }, { llm });
		expect(result).toBeNull();
		expect(calls.length).toBe(0);
	});
});

describe("SIO-1260: configuration", () => {
	test("the kill switch defaults ON and only false/0 disable it", () => {
		expect(isTruncationSynthesisEnabled({})).toBe(true);
		expect(isTruncationSynthesisEnabled({ SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED: "false" })).toBe(false);
		expect(isTruncationSynthesisEnabled({ SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED: "FALSE" })).toBe(false);
		expect(isTruncationSynthesisEnabled({ SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED: "0" })).toBe(false);
		expect(isTruncationSynthesisEnabled({ SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED: "true" })).toBe(true);
	});

	test("the evidence budget falls back on invalid input", () => {
		const fallback = getSynthesisEvidenceBudgetBytes({});
		expect(fallback).toBeGreaterThan(0);
		expect(getSynthesisEvidenceBudgetBytes({ SUBAGENT_SYNTHESIS_EVIDENCE_BYTES: "" })).toBe(fallback);
		expect(getSynthesisEvidenceBudgetBytes({ SUBAGENT_SYNTHESIS_EVIDENCE_BYTES: "nonsense" })).toBe(fallback);
		expect(getSynthesisEvidenceBudgetBytes({ SUBAGENT_SYNTHESIS_EVIDENCE_BYTES: "-5" })).toBe(fallback);
		expect(getSynthesisEvidenceBudgetBytes({ SUBAGENT_SYNTHESIS_EVIDENCE_BYTES: "12345" })).toBe(12345);
	});

	// DELIBERATE divergence from the sibling cap getters, where "0" disables the cap. An uncapped
	// digest could be megabytes, so 0 must fall back rather than mean "unlimited". The kill switch
	// is the way to turn the feature off.
	test("0 does NOT mean unlimited for the evidence budget", () => {
		expect(getSynthesisEvidenceBudgetBytes({ SUBAGENT_SYNTHESIS_EVIDENCE_BYTES: "0" })).toBe(
			getSynthesisEvidenceBudgetBytes({}),
		);
	});
});

// SIO-1260 Layer A. The reservation is ADVISORY -- the model can emit tool_calls anyway and spend
// the reserved step, which is why Layer B carries the guarantee -- but the arithmetic must be right
// or it fires either too early (burning tool budget on every run) or never.
describe("SIO-1260: final-turn reservation arithmetic", () => {
	test("gitlab's limit of 24 reserves on the 12th model turn, not before", () => {
		// A ReAct cycle is two super-steps and the model turn is the odd one, so turn N has consumed
		// 2N-1 steps. At 24: turn 11 -> 21 used, 3 left (no); turn 12 -> 23 used, 1 left (yes).
		expect(shouldReserveFinalTurn(10, 24)).toBe(false);
		expect(shouldReserveFinalTurn(11, 24)).toBe(false);
		expect(shouldReserveFinalTurn(12, 24)).toBe(true);
	});

	test("aws and elastic limits of 40 reserve on the 20th model turn", () => {
		expect(shouldReserveFinalTurn(19, 40)).toBe(false);
		expect(shouldReserveFinalTurn(20, 40)).toBe(true);
	});

	// Once past the threshold it must STAY on -- a turn that ignored the directive still needs it.
	test("the directive stays on for every later turn", () => {
		for (let turn = 12; turn <= 20; turn++) expect(shouldReserveFinalTurn(turn, 24)).toBe(true);
	});

	// The first turn of a healthy run must never be told to stop calling tools, or the reservation
	// would destroy every investigation instead of rescuing the truncated ones.
	test("the first turns of a normal run are never reserved", () => {
		for (const limit of [20, 24, 30, 40]) {
			expect(shouldReserveFinalTurn(1, limit)).toBe(false);
			expect(shouldReserveFinalTurn(2, limit)).toBe(false);
		}
	});
});
