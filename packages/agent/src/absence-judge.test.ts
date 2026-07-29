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

	// SIO-1242 (CodeRabbit, PR #497): the byte budget is now applied PER deploymentId, not per
	// datasource. Under the old whole-datasource cap the FIRST estate consumed all 8KB and the
	// second was truncated away ENTIRELY -- so on a multi-estate turn the judge ruled on a claim
	// about an estate whose evidence it had never seen.
	//
	// The fixture size matters: each entry is first bounded by DIGEST_PER_ENTRY_CAP_BYTES (2048),
	// so a one-entry-per-estate fixture never reaches the 8KB datasource cap and BOTH estates
	// survive even under the old code -- i.e. it proves nothing. 30 entries per estate is past the
	// threshold. Measured against the pre-fix source: hasA=true, hasB=FALSE.
	test("splits the byte budget across deployments so no estate is starved", () => {
		const entriesFor = (tag: string) =>
			Array.from({ length: 30 }, (_, i) => ({
				toolName: `aws_ecs_list_services_${i}`,
				rawJson: `${tag}${"x".repeat(4_000)}`,
			}));
		const digest = buildAbsenceEvidenceDigest(
			[
				result({ dataSourceId: "aws", deploymentId: "estate:A", toolOutputs: entriesFor("AAA") }),
				result({ dataSourceId: "aws", deploymentId: "estate:B", toolOutputs: entriesFor("BBB") }),
			],
			"aws",
		);
		expect(digest).toContain("estate:A");
		// The regression: this was absent before the per-deployment split.
		expect(digest).toContain("estate:B");
		// Labels alone are not enough -- each estate's own payload must survive too.
		expect(digest).toContain("AAA");
		expect(digest).toContain("BBB");
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8_192);
	});

	// The split must not PENALISE the common single-deployment case. Needs many entries so the
	// per-DATASOURCE cap actually binds -- a single entry is bounded by DIGEST_PER_ENTRY_CAP_BYTES
	// (2048) long before the 8KB budget is reached, so a one-entry fixture proves nothing here.
	test("a single deployment still gets the whole budget", () => {
		const manyEntries = Array.from({ length: 12 }, (_, i) => ({
			toolName: `elasticsearch_search_${i}`,
			rawJson: "x".repeat(4_000),
		}));
		const digest = buildAbsenceEvidenceDigest([result({ toolOutputs: manyEntries })], "elastic");
		// Multiple entries survive (so the budget was not divided by a phantom group count), and the
		// whole-datasource bound still holds. Deliberately not asserting the budget is FILLED --
		// truncateToolOutput does not pad to the cap, so an exact-size assertion would pin an
		// implementation detail of the truncator rather than this function's contract.
		expect(Buffer.byteLength(digest, "utf8")).toBeGreaterThan(2_048);
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8_192);
		expect((digest.match(/elasticsearch_search_/g) ?? []).length).toBeGreaterThan(1);
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

	// SIO-1270: `reason` was required, so a model returning perfectly usable verdicts but no
	// justification failed safeParse -> null -> the caller kept the regex verdict and shipped the
	// "treat the returned data as ground truth" caveat. A whole failure mode for a field
	// mapVerdicts discards before it is ever logged.
	test("a verdict omitting `reason` still parses (SIO-1270)", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, contradictedByData: false },
					{ index: 1, contradictedByData: true },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeContradictedAbsenceClaims(CLAIMS, RESULTS)).toEqual([false, true]);
	});

	test("a MISSING contradictedByData still returns null -- only `reason` became optional", async () => {
		const { llm } = fakeLlm(() => JSON.stringify({ verdicts: [{ index: 0 }, { index: 1 }] }));
		_setAbsenceJudgeLlmForTesting(llm);
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

	test("a verdict omitting `reason` still parses (SIO-1270)", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, overgeneralizedAbsence: true },
					{ index: 1, overgeneralizedAbsence: false },
				],
			}),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		expect(await judgeOvergeneralizedAbsenceClaims(LINES)).toEqual([true, false]);
	});
});

// SIO-1266: the judge was shown what a datasource RETURNED and asked "does this contradict the
// claim?", but never that a call had FAILED. On run 2445908e it kept a 1-HOUR claim whose msearch
// had errored, weighed against 30-DAY evidence.
describe("buildAbsenceEvidenceDigest: tool errors (SIO-1266)", () => {
	const withErrors = (over: Record<string, unknown> = {}) =>
		result({
			toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 121, showing 10 from position 0" }],
			toolErrors: [
				{
					toolName: "elasticsearch_multi_search",
					category: "bad-query",
					kind: "bad-input",
					message: "key [header] is not supported in the metadata section",
					statusCode: 400,
				},
			],
			...over,
		});

	test("renders an ERROR line the judge prompt can key on", () => {
		const digest = buildAbsenceEvidenceDigest([withErrors()], "elastic");
		expect(digest).toContain("ERROR elasticsearch_multi_search");
		expect(digest).toContain("key [header] is not supported");
		expect(digest).toContain("(HTTP 400)");
	});

	test("marks a recovered error so the judge can tell it from a dead one", () => {
		const digest = buildAbsenceEvidenceDigest(
			[
				result({
					toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 5" }],
					toolErrors: [
						{ toolName: "elasticsearch_search", category: "server-error", message: "transient", recovered: true },
					],
				}),
			],
			"elastic",
		);
		expect(digest).toContain("[a later call to this tool SUCCEEDED]");
	});

	test("a row with errors but NO payloads still shows the failure", () => {
		// Pre-SIO-1266 this rendered only the placeholder, hiding the failure completely.
		const digest = buildAbsenceEvidenceDigest(
			[
				result({
					toolOutputs: [],
					toolErrors: [{ toolName: "elasticsearch_multi_search", category: "bad-query", message: "boom" }],
				}),
			],
			"elastic",
		);
		expect(digest).toContain("ERROR elasticsearch_multi_search");
		expect(digest).toContain("(no data returned by this datasource this turn)");
	});

	test("errors come FIRST so they survive truncation of the payloads", () => {
		const digest = buildAbsenceEvidenceDigest([withErrors()], "elastic");
		expect(digest.indexOf("ERROR")).toBeLessThan(digest.indexOf("elasticsearch_search: Total results"));
	});

	test("a digest with NO toolErrors is byte-identical to the pre-SIO-1266 output", () => {
		// The error budget is carved out of the existing per-group allowance and only charged to a
		// group that actually has errors, so the no-error path must not shift by a single byte.
		const digest = buildAbsenceEvidenceDigest(RESULTS, "elastic");
		expect(digest).toBe("- [elastic] elasticsearch_search: Total results: 91, showing 5 from position 0");
		expect(digest).not.toContain("ERROR");
	});

	test("an unknown datasource still returns exactly the placeholder", () => {
		expect(buildAbsenceEvidenceDigest(RESULTS, "kafka")).toBe("(no data returned by this datasource this turn)");
	});

	test("stays within the per-datasource byte budget with many errors", () => {
		const many = result({
			deploymentId: "prod-a",
			toolOutputs: Array.from({ length: 30 }, (_, i) => ({
				toolName: `elasticsearch_search_${i}`,
				rawJson: "x".repeat(2_000),
			})),
			toolErrors: Array.from({ length: 20 }, (_, i) => ({
				toolName: `elasticsearch_multi_search_${i}`,
				category: "bad-query",
				message: "y".repeat(2_000),
			})),
		});
		const digest = buildAbsenceEvidenceDigest([many], "elastic");
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8_192);
		expect(digest).toContain("ERROR");
	});
});

describe("judge prompt: errors and windows (SIO-1266)", () => {
	test("tells the model that ERROR lines are failures and that a stated window matters", async () => {
		const { calls, llm } = fakeLlm(() =>
			JSON.stringify({ verdicts: CLAIMS.map((_, i) => ({ index: i, contradictedByData: true, reason: "r" })) }),
		);
		_setAbsenceJudgeLlmForTesting(llm);
		await judgeContradictedAbsenceClaims(CLAIMS, RESULTS);
		const sent = JSON.stringify(calls[0]);
		expect(sent).toContain("are tool FAILURES, not data");
		expect(sent).toContain("TIME WINDOW");
		// The concrete arithmetic the run got wrong.
		expect(sent).toContain("121 hits over 30 days says nothing about one hour");
	});

	// SIO-1270: the 8s deadline abort on run eaebc62b came with ~40-word `reason` strings against
	// maxTokens 1024. Verdicts are load-bearing; justifications are not.
	test("tells the model to keep `reason` short and to drop it before dropping verdicts", async () => {
		const { calls, llm } = fakeLlm(() => verdictJson([true, true]));
		_setAbsenceJudgeLlmForTesting(llm);
		await judgeContradictedAbsenceClaims(CLAIMS, RESULTS);
		const sent = JSON.stringify(calls[0]);
		expect(sent).toContain("under 15 words");
		expect(sent).toContain("omit");
	});
});
