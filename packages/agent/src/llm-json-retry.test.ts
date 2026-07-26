// agent/src/llm-json-retry.test.ts

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildCorrectionPrompt, parseLlmJsonWithCorrection } from "./llm-json-retry.ts";

const schema = z.object({ dataSources: z.array(z.string()) });

// The LLM is injected as a callback precisely so this needs no mock.module and no LangChain.
function stubReinvoke(response: string, calls: string[] = []) {
	return async (correction: string) => {
		calls.push(correction);
		return response;
	};
}

describe("buildCorrectionPrompt", () => {
	test("quotes the validation error and names the expected top-level keys", () => {
		const prompt = buildCorrectionPrompt("dataSources: expected array, received undefined", [
			"dataSources",
			"severity",
		]);
		expect(prompt).toContain("dataSources: expected array, received undefined");
		expect(prompt).toContain("dataSources, severity");
	});

	// The container key is the drift this whole ticket exists for; the instruction must be explicit.
	test("forbids a container key", () => {
		expect(buildCorrectionPrompt("x", ["a"])).toContain("Do not wrap it in any container key");
	});
});

describe("parseLlmJsonWithCorrection", () => {
	test("does NOT re-invoke when the first response already validates", async () => {
		const calls: string[] = [];
		const result = await parseLlmJsonWithCorrection('{"dataSources":["kafka"]}', schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke("unused", calls),
		});
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(0);
	});

	test("re-invokes once and succeeds on the corrected response", async () => {
		const calls: string[] = [];
		const result = await parseLlmJsonWithCorrection('{"entities":{"nope":1}}', schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke('{"dataSources":["kafka"]}', calls),
		});
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(2);
		if (result.ok) expect(result.data.dataSources).toEqual(["kafka"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("dataSources");
	});

	// Single-shot by design: a loop multiplies latency on exactly the slowest turns, and two
	// failures in a row is a prompt problem, not a sampling one.
	test("re-invokes at most once, then degrades", async () => {
		const calls: string[] = [];
		const result = await parseLlmJsonWithCorrection('{"bad":1}', schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke('{"still":"wrong"}', calls),
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(2);
		expect(calls).toHaveLength(1);
	});

	test("fires onRetry with the first failure, including observedKeys", async () => {
		let seen: { reason: string; observedKeys?: readonly string[] } | undefined;
		await parseLlmJsonWithCorrection('{"data_sources":[],"note":"x"}', schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke('{"dataSources":[]}'),
			onRetry: (first) => {
				seen = { reason: first.reason, observedKeys: first.observedKeys };
			},
		});
		expect(seen?.reason).toBe("schema-mismatch");
		expect(seen?.observedKeys).toEqual(["data_sources", "note"]);
	});

	// A failed re-ask (invoke error, or an aborted RunnableConfig signal) must degrade to the
	// ORIGINAL diagnosis -- that is what describes what the model actually sent.
	test("reports the first failure when the re-invoke itself throws", async () => {
		const result = await parseLlmJsonWithCorrection('{"data_sources":[]}', schema, {
			expectedKeys: ["dataSources"],
			reinvoke: async () => {
				throw new Error("aborted");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(2);
		if (!result.ok) {
			expect(result.message).toContain("dataSources");
			expect(result.observedKeys).toEqual(["data_sources"]);
		}
	});

	test("never throws when the model returns no JSON at all", async () => {
		const result = await parseLlmJsonWithCorrection("I cannot help with that.", schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke("still no json"),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no-json");
	});

	// The empty-text case (a reasoning-only Sonnet 5 turn) reaches here as "" and must route
	// into the re-ask rather than throwing.
	test("treats an empty first response as a failure and re-asks", async () => {
		const calls: string[] = [];
		const result = await parseLlmJsonWithCorrection("", schema, {
			expectedKeys: ["dataSources"],
			reinvoke: stubReinvoke('{"dataSources":["elastic"]}', calls),
		});
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
	});
});
