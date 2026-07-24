// packages/agent/src/absence-judge.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import {
	_setAbsenceJudgeLlmForTesting,
	buildAbsenceEvidenceDigest,
	isAbsenceJudgeEnabled,
	judgeContradictedAbsenceClaims,
	judgeOvergeneralizedAbsenceClaims,
} from "./absence-judge.ts";

// No module mocks here: the judge exposes an LLM seam (_setAbsenceJudgeLlmForTesting) so
// this suite stays clean of the process-global @langchain/aws mock other suites install.

// The two 2026-07 production shapes (identifiers genericized): a scoped zero-hit finding
// (false positive) and the SIO-1085 motivating true positive -- structurally identical to
// a regex, separable only by the evidence.
const CLAIMS = [
	{
		line: "styles-search-service has 56M+ log events but zero hits for the HTTP 500 phrase in its own APM error stream",
		dataSourceId: "elastic",
	},
	{
		line: "order-sync-service does not ship logs to the connected Elasticsearch cluster; 0 hits for the checkout error.",
		dataSourceId: "elastic",
	},
];

function result(over: Record<string, unknown>): DataSourceResult {
	return { dataSourceId: "elastic", data: {}, status: "success", ...over } as unknown as DataSourceResult;
}

const RESULTS = [
	result({
		toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 91, showing 5 from position 0" }],
	}),
];

function fakeLlm(respond: () => string | Promise<string>) {
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

function verdictJson(bools: boolean[]): string {
	return JSON.stringify({ verdicts: bools.map((b, index) => ({ index, contradictedByData: b, reason: "r" })) });
}

afterEach(() => {
	_setAbsenceJudgeLlmForTesting(null);
	delete process.env.ABSENCE_JUDGE_ENABLED;
});

describe("isAbsenceJudgeEnabled (SIO-1158)", () => {
	test("defaults ON when unset", () => {
		expect(isAbsenceJudgeEnabled({})).toBe(true);
	});

	test("'false' and '0' disable; 'true' enables", () => {
		expect(isAbsenceJudgeEnabled({ ABSENCE_JUDGE_ENABLED: "false" })).toBe(false);
		expect(isAbsenceJudgeEnabled({ ABSENCE_JUDGE_ENABLED: "0" })).toBe(false);
		expect(isAbsenceJudgeEnabled({ ABSENCE_JUDGE_ENABLED: "true" })).toBe(true);
	});
});

describe("buildAbsenceEvidenceDigest (SIO-1158)", () => {
	test("renders toolName with string rawJson", () => {
		const digest = buildAbsenceEvidenceDigest(RESULTS, "elastic");
		expect(digest).toContain("elasticsearch_search: Total results: 91");
	});

	test("stringifies object rawJson and labels deployments", () => {
		const digest = buildAbsenceEvidenceDigest(
			[
				result({
					deploymentId: "prod-a",
					toolOutputs: [{ toolName: "elasticsearch_search", rawJson: { hits: { hits: [{ _id: "a" }] } } }],
				}),
			],
			"elastic",
		);
		expect(digest).toContain("[elastic/prod-a] elasticsearch_search:");
		expect(digest).toContain('"_id":"a"');
	});

	test("includes typed findings blocks", () => {
		const digest = buildAbsenceEvidenceDigest(
			[result({ dataSourceId: "kafka", kafkaFindings: { dlqTopics: [{ name: "DLQ_x", depth: 3 }] } })],
			"kafka",
		);
		expect(digest).toContain("findings.kafkaFindings:");
		expect(digest).toContain("DLQ_x");
	});

	test("excludes other datasources' results", () => {
		const digest = buildAbsenceEvidenceDigest(
			[
				...RESULTS,
				result({ dataSourceId: "kafka", toolOutputs: [{ toolName: "kafka_list_topics", rawJson: "topics: 12" }] }),
			],
			"elastic",
		);
		expect(digest).toContain("Total results: 91");
		expect(digest).not.toContain("kafka_list_topics");
	});

	test("returns a no-data placeholder for an unknown datasource", () => {
		expect(buildAbsenceEvidenceDigest(RESULTS, "couchbase")).toBe("(no data returned by this datasource this turn)");
	});

	test("bounds a huge rawJson under the per-datasource cap with a truncation marker", () => {
		const digest = buildAbsenceEvidenceDigest(
			[result({ toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "x".repeat(100_000) }] })],
			"elastic",
		);
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8_192);
		expect(digest).toContain("[truncated");
	});
});

describe("judgeContradictedAbsenceClaims (SIO-1158)", () => {
	test("returns [] for an empty claim list without invoking the LLM", async () => {
		const { calls, llm } = fakeLlm(() => "should not be called");
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims([], RESULTS)).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("maps verdicts by index, tolerating out-of-order responses", async () => {
		const { calls, llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 1, contradictedByData: true, reason: "the checkout-error search returned 91 hits" },
					{ index: 0, contradictedByData: false, reason: "scoped zero-hit finding" },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toEqual([false, true]);
		expect(calls).toHaveLength(1);
	});

	test("tolerates fenced/garnished JSON around the verdict object", async () => {
		const { llm } = fakeLlm(() => `Here you go:\n\`\`\`json\n${verdictJson([true, true])}\n\`\`\``);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toEqual([true, true]);
	});

	test("verdict count mismatch returns null (fail-closed)", async () => {
		const { llm } = fakeLlm(() => verdictJson([true]));
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("out-of-range verdict index returns null", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, contradictedByData: false, reason: "r" },
					{ index: 5, contradictedByData: false, reason: "r" },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("duplicated verdict index returns null", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, contradictedByData: false, reason: "r" },
					{ index: 0, contradictedByData: true, reason: "r" },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("non-JSON content returns null", async () => {
		const { llm } = fakeLlm(() => "I cannot judge these sentences.");
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("schema-invalid JSON returns null", async () => {
		const { llm } = fakeLlm(() => JSON.stringify({ verdicts: [{ index: 0, verdict: "yes" }, { index: 1 }] }));
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("an LLM error returns null (fail-closed)", async () => {
		_setAbsenceJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("bedrock unavailable");
			},
		});
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toBeNull();
	});

	test("an externally aborted signal rethrows instead of failing closed", async () => {
		_setAbsenceJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("request aborted");
			},
		});
		const controller = new AbortController();
		controller.abort();
		let thrown: unknown = null;
		try {
			await judgeContradictedAbsenceClaims(CLAIMS, RESULTS, { signal: controller.signal });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("request aborted");
	});

	test("the human message carries numbered datasource-labelled claims AND the evidence digest", async () => {
		const { calls, llm } = fakeLlm(() => verdictJson([true, true]));
		_setAbsenceJudgeLlmForTesting(llm);
		await judgeContradictedAbsenceClaims(CLAIMS, RESULTS);
		const messages = calls[0] as Array<{ content: unknown }>;
		const human = String(messages[messages.length - 1]?.content ?? "");
		expect(human).toContain("0: [datasource: elastic] styles-search-service");
		expect(human).toContain("1: [datasource: elastic] order-sync-service");
		expect(human).toContain("--- datasource elastic returned this turn ---");
		expect(human).toContain("Total results: 91");
	});
});

// SIO-1198 Part A: the OVERGENERALIZED arm gets the same veto treatment. The judgment
// is textual (universal assertion vs explicitly scoped enumeration) -- tool INPUTS are
// not persisted in state, and the flag is about claim phrasing, not data contradiction.
describe("judgeOvergeneralizedAbsenceClaims (SIO-1198)", () => {
	afterEach(() => _setAbsenceJudgeLlmForTesting(null));

	const LINES = [
		"Style code TH1037 absent from all queried collections: styles.product2g, styles.variant, styles.archived_styles",
		"The AFS mapping is entirely absent from all records anywhere in the pipeline",
	];

	test("returns [] for an empty list without invoking the LLM", async () => {
		const { calls, llm } = fakeLlm(() => "{}");
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims([])).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("maps verdicts by index: scoped enumeration vetoed, universal claim confirmed", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 1, overgeneralizedAbsence: true, reason: "universal, no enumeration" },
					{ index: 0, overgeneralizedAbsence: false, reason: "explicitly scoped to enumerated collections" },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims(LINES)).toEqual([false, true]);
	});

	test("verdict count mismatch returns null (fail-closed)", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({ verdicts: [{ index: 0, overgeneralizedAbsence: true, reason: "r" }] }),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims(LINES)).toBeNull();
	});

	test("non-JSON content returns null (fail-closed)", async () => {
		const { llm } = fakeLlm(() => "the claims look fine to me");
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims(LINES)).toBeNull();
	});

	test("LLM throw returns null (fail-closed) unless the caller aborted", async () => {
		const { llm } = fakeLlm(() => {
			throw new Error("bedrock unavailable");
		});
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims(LINES)).toBeNull();
	});
});
