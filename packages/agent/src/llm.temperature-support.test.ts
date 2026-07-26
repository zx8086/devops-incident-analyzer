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

const { createLlm } = await import("./llm.ts");

// SIO-1223: the `modelAcceptsTemperature` unit block that used to live here is gone with the
// function. Temperature acceptance is no longer derived by substring-matching a Bedrock id --
// it is declared per model in MODEL_REGISTRY, so the equivalent coverage now lives in
// packages/gitagent-bridge/src/model-registry.test.ts ("acceptsTemperature agrees with the
// 4.7+/5-generation rule for every entry"), which checks the DECLARATIONS against the same
// generation rule this block used to check the matcher against.
//
// What stays here is the part that block could never prove: that no `temperature` key actually
// reaches the ChatBedrockConverse constructor, for the primary AND the manifest fallback.

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
