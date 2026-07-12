// agent/src/graph-knowledge.embedder.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const seen: { text: string | null; maxRetries: number | undefined } = { text: null, maxRetries: undefined };

// SIO-1081: the real createBedrockEmbedder EmbedFn must head-truncate its input before calling
// BedrockEmbeddings.embedQuery so a large pasted incident stays under Titan v2's 8192-token cap.
// This file mock.module's @langchain/aws in isolation: module mocks are process-scoped and would
// poison sibling tests (see reference_bun_mock_namespace_live_binding_poisoning).
mock.module("@langchain/aws", () => ({
	BedrockEmbeddings: class {
		maxRetries: number | undefined;
		constructor(fields?: { maxRetries?: number }) {
			seen.maxRetries = fields?.maxRetries;
		}
		async embedQuery(text: string): Promise<number[]> {
			seen.text = text;
			return [0.1, 0.2, 0.3];
		}
	},
}));

import { createBedrockEmbedder } from "./graph-knowledge.ts";

const prevMax = process.env.EMBEDDINGS_MAX_CHARS;

beforeEach(() => {
	seen.text = null;
	seen.maxRetries = undefined;
	delete process.env.EMBEDDINGS_MAX_CHARS; // default cap 24000
});

afterEach(() => {
	if (prevMax === undefined) delete process.env.EMBEDDINGS_MAX_CHARS;
	else process.env.EMBEDDINGS_MAX_CHARS = prevMax;
});

describe("createBedrockEmbedder", () => {
	test("head-truncates oversized input before embedQuery and keeps the front", async () => {
		const embed = createBedrockEmbedder();
		const huge = `HEAD_MARKER${"x".repeat(50_000)}`;
		await embed(huge);
		expect(seen.text?.length).toBe(24_000);
		expect(seen.text?.startsWith("HEAD_MARKER")).toBe(true);
	});

	test("passes short input through unchanged", async () => {
		const embed = createBedrockEmbedder();
		await embed("kafka lag");
		expect(seen.text).toBe("kafka lag");
	});

	test("constructs BedrockEmbeddings with maxRetries: 0 (no retry storm on a 400)", async () => {
		const embed = createBedrockEmbedder();
		await embed("anything");
		expect(seen.maxRetries).toBe(0);
	});
});
