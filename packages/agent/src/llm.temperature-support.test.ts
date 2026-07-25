// packages/agent/src/llm.temperature-support.test.ts
//
// SIO-1214: Claude 4.7+/5-generation Bedrock models reject `temperature` outright
// ("temperature is deprecated for this model") rather than accepting and ignoring
// it. This regression was caught live in production after the SIO-1213 Sonnet 5 /
// Opus 4.8 upgrade -- every subAgent invocation failed because ROLE_OVERRIDES.subAgent
// is {} and resolveBedrockConfig() defaults temperature to 0, which buildChatModel()
// always forwarded to ChatBedrockConverse regardless of model generation.
import { describe, expect, test } from "bun:test";
import { modelAcceptsTemperature } from "./llm.ts";

describe("modelAcceptsTemperature (SIO-1214)", () => {
	test("rejects temperature for the newly-adopted Sonnet 5 / Opus 4.8 EU inference profiles", () => {
		expect(modelAcceptsTemperature("eu.anthropic.claude-sonnet-5")).toBe(false);
		expect(modelAcceptsTemperature("eu.anthropic.claude-opus-4-8")).toBe(false);
	});

	test("rejects temperature for other 4.7+/5-generation ids by suffix", () => {
		expect(modelAcceptsTemperature("us.anthropic.claude-opus-4-7")).toBe(false);
		expect(modelAcceptsTemperature("eu.anthropic.claude-fable-5")).toBe(false);
		expect(modelAcceptsTemperature("global.anthropic.claude-mythos-5")).toBe(false);
	});

	test("still accepts temperature for pre-4.7 model ids in MODEL_MAP", () => {
		expect(modelAcceptsTemperature("eu.anthropic.claude-sonnet-4-6")).toBe(true);
		expect(modelAcceptsTemperature("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(modelAcceptsTemperature("eu.anthropic.claude-opus-4-6-v1")).toBe(true);
	});
});
