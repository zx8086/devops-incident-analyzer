// packages/agent/src/llm.tier.test.ts
//
// SIO-1040: generalized model tiering. isLightweightRole resolves the light/standard
// tier per role from AGENT_LLM_TIER_<ROLE> env vars, defaulting to classifier-only.
import { describe, expect, test } from "bun:test";
import { isLightweightRole } from "./llm.ts";

describe("isLightweightRole defaults (SIO-1040)", () => {
	test("classifier is light by default (status quo)", () => {
		expect(isLightweightRole("classifier", {})).toBe(true);
	});

	// SIO-1149: the gaps veto judge ships light by design (per-bullet boolean verdicts),
	// overridable to standard via AGENT_LLM_TIER_GAPS_JUDGE=standard.
	test("gapsJudge is light by default and overridable to standard", () => {
		expect(isLightweightRole("gapsJudge", {})).toBe(true);
		expect(isLightweightRole("gapsJudge", { AGENT_LLM_TIER_GAPS_JUDGE: "standard" })).toBe(false);
	});

	test("every other tierable role is standard by default (rollout is classifier-only)", () => {
		for (const role of [
			"entityExtractor",
			"normalizer",
			"awsEstateRouter",
			"runbookSelector",
			"followUp",
			"actionProposal",
		] as const) {
			expect(isLightweightRole(role, {})).toBe(false);
		}
	});

	test("non-tierable roles are never light, even with a light override", () => {
		// aggregator/subAgent/orchestrator/iac* are not in TIERABLE_ROLES.
		expect(isLightweightRole("aggregator", { AGENT_LLM_TIER_AGGREGATOR: "light" })).toBe(false);
		expect(isLightweightRole("subAgent", { AGENT_LLM_TIER_SUB_AGENT: "light" })).toBe(false);
		expect(isLightweightRole("orchestrator", {})).toBe(false);
		expect(isLightweightRole("iacDrafter", { AGENT_LLM_TIER_IAC_DRAFTER: "light" })).toBe(false);
	});
});

describe("isLightweightRole env matrix (SIO-1040)", () => {
	test("light override forces a standard-default role to light", () => {
		expect(isLightweightRole("entityExtractor", { AGENT_LLM_TIER_ENTITY_EXTRACTOR: "light" })).toBe(true);
	});

	test("standard override forces a light-default role (classifier) to standard", () => {
		expect(isLightweightRole("classifier", { AGENT_LLM_TIER_CLASSIFIER: "standard" })).toBe(false);
	});

	test("override is case-insensitive", () => {
		expect(isLightweightRole("entityExtractor", { AGENT_LLM_TIER_ENTITY_EXTRACTOR: "LIGHT" })).toBe(true);
		expect(isLightweightRole("classifier", { AGENT_LLM_TIER_CLASSIFIER: "Standard" })).toBe(false);
	});

	test("unrecognised / empty value falls through to the default", () => {
		expect(isLightweightRole("classifier", { AGENT_LLM_TIER_CLASSIFIER: "" })).toBe(true);
		expect(isLightweightRole("classifier", { AGENT_LLM_TIER_CLASSIFIER: "nonsense" })).toBe(true);
		expect(isLightweightRole("entityExtractor", { AGENT_LLM_TIER_ENTITY_EXTRACTOR: "nonsense" })).toBe(false);
	});

	test("camelCase roles use SCREAMING_SNAKE env keys", () => {
		expect(isLightweightRole("awsEstateRouter", { AGENT_LLM_TIER_AWS_ESTATE_ROUTER: "light" })).toBe(true);
		expect(isLightweightRole("runbookSelector", { AGENT_LLM_TIER_RUNBOOK_SELECTOR: "light" })).toBe(true);
		expect(isLightweightRole("followUp", { AGENT_LLM_TIER_FOLLOW_UP: "light" })).toBe(true);
		expect(isLightweightRole("actionProposal", { AGENT_LLM_TIER_ACTION_PROPOSAL: "light" })).toBe(true);
	});
});
