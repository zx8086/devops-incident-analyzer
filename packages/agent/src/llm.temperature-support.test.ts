// agent/src/llm.temperature-support.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Claude Sonnet 5 / Opus 4.7+ reject `temperature` outright ("temperature is
// deprecated for this model"). Capture every options object ChatBedrockConverse is
// constructed with -- createLlm builds one for the primary model AND one for the
// manifest fallback, so a single "last call" capture silently observes the wrong one.
let constructorCalls: Record<string, unknown>[] = [];

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		constructor(options: Record<string, unknown>) {
			constructorCalls.push(options);
		}
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			return { content: "" };
		}
	},
}));

function optionsFor(modelId: string): Record<string, unknown> | undefined {
	return constructorCalls.find((options) => options.model === modelId);
}

const { createLlm, modelAcceptsTemperature } = await import("./llm.ts");

describe("modelAcceptsTemperature (SIO-1214)", () => {
	test("rejects temperature for the newly-adopted Sonnet 5 / Opus 4.8 EU inference profiles", () => {
		expect(modelAcceptsTemperature("eu.anthropic.claude-sonnet-5")).toBe(false);
		expect(modelAcceptsTemperature("eu.anthropic.claude-opus-4-8")).toBe(false);
	});

	test("rejects temperature for other 4.7+/5-generation ids, including versioned/dated variants", () => {
		expect(modelAcceptsTemperature("us.anthropic.claude-opus-4-7")).toBe(false);
		expect(modelAcceptsTemperature("eu.anthropic.claude-fable-5")).toBe(false);
		expect(modelAcceptsTemperature("global.anthropic.claude-mythos-5")).toBe(false);
		// substring match (not endsWith) so a future dated/versioned Bedrock id still matches
		expect(modelAcceptsTemperature("eu.anthropic.claude-sonnet-5-20260601-v1:0")).toBe(false);
	});

	test("still accepts temperature for pre-4.7 model ids in MODEL_MAP", () => {
		expect(modelAcceptsTemperature("eu.anthropic.claude-sonnet-4-6")).toBe(true);
		expect(modelAcceptsTemperature("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(modelAcceptsTemperature("eu.anthropic.claude-opus-4-6-v1")).toBe(true);
	});
});

describe("buildChatModel via createLlm (SIO-1214)", () => {
	beforeEach(() => {
		constructorCalls = [];
	});

	afterEach(() => {
		constructorCalls = [];
	});

	// incident-analyzer's manifest prefers claude-sonnet-5 with a haiku-4-5 fallback
	// (SIO-1213): the primary build must omit temperature, the fallback build must send it.
	test("omits temperature for the Sonnet 5 primary, keeps it for the Haiku 4.5 fallback", () => {
		createLlm("normalizer", "incident-analyzer");
		const primaryOptions = optionsFor("eu.anthropic.claude-sonnet-5");
		const fallbackOptions = optionsFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(primaryOptions).toBeDefined();
		expect(fallbackOptions).toBeDefined();
		expect(primaryOptions).not.toHaveProperty("temperature");
		expect(fallbackOptions).toHaveProperty("temperature");
	});

	// elastic-iac's manifest prefers claude-opus-4-8 with a claude-sonnet-5 fallback
	// (SIO-1213): both are in the no-temperature family, so neither build should send it.
	test("omits temperature for both the Opus 4.8 primary and the Sonnet 5 fallback", () => {
		createLlm("iacPlanner", "elastic-iac");
		const primaryOptions = optionsFor("eu.anthropic.claude-opus-4-8");
		const fallbackOptions = optionsFor("eu.anthropic.claude-sonnet-5");
		expect(primaryOptions).toBeDefined();
		expect(fallbackOptions).toBeDefined();
		expect(primaryOptions).not.toHaveProperty("temperature");
		expect(fallbackOptions).not.toHaveProperty("temperature");
	});

	// classifier is light-tier by default (SIO-1040) and borrows the elastic-agent
	// sub-manifest's model, still claude-haiku-4-5 -- temperature must still be sent.
	test("still includes temperature for a role resolving to Haiku 4.5 (light tier)", () => {
		createLlm("classifier", "incident-analyzer");
		const primaryOptions = optionsFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(primaryOptions).toBeDefined();
		expect(primaryOptions).toHaveProperty("temperature");
	});
});
