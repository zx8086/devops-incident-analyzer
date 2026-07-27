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

// SIO-1235: the subAgent role now resolves from the SPECIALIST's manifest, not root's.
// Before this, all 7 sub-agent manifests' `model.preferred: claude-haiku-4-5` was dead config
// (since the 125b3f9e scaffold) -- which is why flipping one line in the root agent.yaml at
// SIO-1213 silently moved every specialist onto Sonnet 5.
describe("subAgent resolves its own manifest model (SIO-1235)", () => {
	// SIO-1262: sub-agent manifests declare claude-sonnet-4-6 (probed 2026-07-27) with haiku as
	// FALLBACK. Deliberately NOT sonnet-5: that model has acceptsTemperature: false, so the
	// manifests' temperature 0.1 would silently stop applying -- and being identical to the root
	// model it would also make every "resolved from the sub-agent manifest, not the root" assertion
	// below vacuous.
	const SUB = "eu.anthropic.claude-sonnet-4-6";
	const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
	const ROOT = "eu.anthropic.claude-sonnet-5";

	beforeEach(() => {
		constructorCalls = [];
		delete process.env.SUB_AGENT_MANIFEST_MODEL_ENABLED;
	});

	afterEach(() => {
		constructorCalls = [];
		delete process.env.SUB_AGENT_MANIFEST_MODEL_ENABLED;
	});

	test.each([
		"elastic-agent",
		"kafka-agent",
		"capella-agent",
		"konnect-agent",
		"gitlab-agent",
		"atlassian-agent",
		"aws-agent",
	])("%s builds Sonnet 4.6 from its own manifest", (subAgentName) => {
		createLlm("subAgent", "incident-analyzer", subAgentName);
		const options = optionsFor(SUB);
		expect(options).toBeDefined();
		// subAgent is a TOOL_BINDING_ROLE, so createLlm skips withFallbacks -- exactly one model
		// is constructed. More than one would mean a fallback chain crept back in.
		expect(constructorCalls).toHaveLength(1);
	});

	// temperature: 0.1 is declared in every sub-agent manifest and had NEVER applied, because the
	// root model (Sonnet 5) has acceptsTemperature: false and llm.ts drops it. Sonnet 4.6 accepts
	// it (probed), which is a large part of why the sub-agents point there and not at the root model.
	test("temperature 0.1 from the manifest now actually applies", () => {
		createLlm("subAgent", "incident-analyzer", "gitlab-agent");
		expect(optionsFor(SUB)).toHaveProperty("temperature", 0.1);
	});

	// ROLE_OVERRIDES.subAgent.maxTokens wins over the manifest's constraints.max_tokens: 2048,
	// via `overrides.maxTokens ?? bedrockConfig.maxTokens`. 8192 clears haiku's 4096 floor;
	// silently inheriting 2048 would truncate long sub-agent answers.
	test("maxTokens stays 8192 -- the role override beats the manifest's 2048", () => {
		createLlm("subAgent", "incident-analyzer", "kafka-agent");
		expect(optionsFor(SUB)).toHaveProperty("maxTokens", 8192);
	});

	test("without a subAgentName it still resolves from the root manifest", () => {
		createLlm("subAgent");
		expect(optionsFor(ROOT)).toBeDefined();
		expect(optionsFor(SUB)).toBeUndefined();
	});

	test.each([
		["false", ROOT],
		["0", ROOT],
		["true", SUB],
	])("SUB_AGENT_MANIFEST_MODEL_ENABLED=%s resolves %s", (value, expectedModel) => {
		process.env.SUB_AGENT_MANIFEST_MODEL_ENABLED = value;
		createLlm("subAgent", "incident-analyzer", "gitlab-agent");
		expect(optionsFor(expectedModel)).toBeDefined();
	});

	// The kill switch must restore the PREVIOUS behaviour exactly, temperature included -- Sonnet 5
	// rejects the key outright, so leaking it back would break every sub-agent call.
	test("kill switch restores root model with no temperature key", () => {
		process.env.SUB_AGENT_MANIFEST_MODEL_ENABLED = "false";
		createLlm("subAgent", "incident-analyzer", "gitlab-agent");
		expect(optionsFor(ROOT)).not.toHaveProperty("temperature");
	});

	// Degrade loudly, never fail: a name absent from the orchestrator's `agents:` map (the
	// SIO-1229 class of bug) must not take that datasource offline.
	test("an unknown sub-agent name falls back to root without throwing", () => {
		expect(() => createLlm("subAgent", "incident-analyzer", "does-not-exist-agent")).not.toThrow();
		expect(optionsFor(ROOT)).toBeDefined();
	});

	// Non-subAgent roles must ignore subAgentName entirely, or passing it anywhere else would
	// silently re-point ~25 call sites.
	test("a non-subAgent role ignores subAgentName", () => {
		createLlm("aggregator", "incident-analyzer", "gitlab-agent");
		expect(optionsFor(ROOT)).toBeDefined();
	});
});
