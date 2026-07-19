// packages/agent/src/gaps-judge.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _setGapsJudgeLlmForTesting, isGapsJudgeEnabled, judgeDegradingGapBullets } from "./gaps-judge.ts";

// No module mocks here: the judge exposes an LLM seam (_setGapsJudgeLlmForTesting) so
// this suite stays clean of the process-global @langchain/aws mock other suites install.

const BULLETS = [
	"- gitlab_blast_radius was unavailable (Orbit schema violation).",
	"- kafka_list_dlq_topics timed out; a full DLQ topic list was not retrieved.",
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

afterEach(() => {
	_setGapsJudgeLlmForTesting(null);
	delete process.env.GAPS_JUDGE_ENABLED;
});

describe("isGapsJudgeEnabled (SIO-1149)", () => {
	test("defaults ON when unset", () => {
		expect(isGapsJudgeEnabled({})).toBe(true);
	});

	test("'false' and '0' disable; 'true' enables", () => {
		expect(isGapsJudgeEnabled({ GAPS_JUDGE_ENABLED: "false" })).toBe(false);
		expect(isGapsJudgeEnabled({ GAPS_JUDGE_ENABLED: "0" })).toBe(false);
		expect(isGapsJudgeEnabled({ GAPS_JUDGE_ENABLED: "true" })).toBe(true);
	});
});

describe("judgeDegradingGapBullets (SIO-1149)", () => {
	test("returns [] for an empty bullet list without invoking the LLM", async () => {
		const { calls, llm } = fakeLlm(() => "should not be called");
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets([])).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("maps verdicts by index, tolerating out-of-order responses", async () => {
		const { calls, llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 1, genuineUnrecoveredFailure: false, reason: "recovered by direct inspection" },
					{ index: 0, genuineUnrecoveredFailure: true, reason: "genuinely missing" },
				],
			}),
		);
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toEqual([true, false]);
		expect(calls).toHaveLength(1);
	});

	test("tolerates fenced/garnished JSON around the verdict object", async () => {
		const { llm } = fakeLlm(
			() =>
				'Here you go:\n```json\n{"verdicts":[{"index":0,"genuineUnrecoveredFailure":true,"reason":"r"},{"index":1,"genuineUnrecoveredFailure":true,"reason":"r"}]}\n```',
		);
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toEqual([true, true]);
	});

	test("verdict count mismatch returns null (fail-closed)", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({ verdicts: [{ index: 0, genuineUnrecoveredFailure: false, reason: "r" }] }),
		);
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	test("out-of-range verdict index returns null", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, genuineUnrecoveredFailure: false, reason: "r" },
					{ index: 5, genuineUnrecoveredFailure: false, reason: "r" },
				],
			}),
		);
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	test("duplicated verdict index returns null", async () => {
		const { llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, genuineUnrecoveredFailure: false, reason: "r" },
					{ index: 0, genuineUnrecoveredFailure: true, reason: "r" },
				],
			}),
		);
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	test("non-JSON content returns null", async () => {
		const { llm } = fakeLlm(() => "I cannot judge these bullets.");
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	test("schema-invalid JSON returns null", async () => {
		const { llm } = fakeLlm(() => JSON.stringify({ verdicts: [{ index: 0, verdict: "yes" }, { index: 1 }] }));
		_setGapsJudgeLlmForTesting(llm);
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	test("an LLM error returns null (fail-closed)", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("bedrock unavailable");
			},
		});
		expect(await judgeDegradingGapBullets(BULLETS)).toBeNull();
	});

	// CodeRabbit (PR #416): a caller-requested cancellation must propagate; only
	// judge-local failures fail closed.
	test("an externally aborted signal rethrows instead of failing closed", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("request aborted");
			},
		});
		const controller = new AbortController();
		controller.abort();
		let thrown: unknown = null;
		try {
			await judgeDegradingGapBullets(BULLETS, { signal: controller.signal });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("request aborted");
	});

	test("the prompt hands the judge numbered bullets", async () => {
		const { calls, llm } = fakeLlm(() =>
			JSON.stringify({
				verdicts: [
					{ index: 0, genuineUnrecoveredFailure: true, reason: "r" },
					{ index: 1, genuineUnrecoveredFailure: true, reason: "r" },
				],
			}),
		);
		_setGapsJudgeLlmForTesting(llm);
		await judgeDegradingGapBullets(BULLETS);
		const messages = calls[0] as Array<{ content: unknown }>;
		const human = String(messages[messages.length - 1]?.content ?? "");
		expect(human).toContain("0: - gitlab_blast_radius");
		expect(human).toContain("1: - kafka_list_dlq_topics");
	});
});
