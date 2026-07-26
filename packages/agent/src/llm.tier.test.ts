// packages/agent/src/llm.tier.test.ts
//
// SIO-1040: generalized model tiering. isLightweightRole resolves the light/standard
// tier per role from AGENT_LLM_TIER_<ROLE> env vars, defaulting to classifier-only.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import { isLightweightRole, isSubAgentManifestModelEnabled, resolveRoleModelConfig } from "./llm.ts";
import { AGENT_NAMES as SUB_AGENT_NAMES } from "./sub-agent.ts";

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

	// SIO-1158: the absence veto judge ships light by design (per-claim boolean verdicts),
	// overridable to standard via AGENT_LLM_TIER_ABSENCE_JUDGE=standard.
	test("absenceJudge is light by default and overridable to standard", () => {
		expect(isLightweightRole("absenceJudge", {})).toBe(true);
		expect(isLightweightRole("absenceJudge", { AGENT_LLM_TIER_ABSENCE_JUDGE: "standard" })).toBe(false);
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

// SIO-1235: the kill switch for per-specialist model resolution. Defaults ON and is read at
// CALL time, so flipping it needs only a container restart -- the rollback lever if Haiku 4.5
// turns out to underperform on the ReAct loops (the one thing no offline test can answer).
describe("isSubAgentManifestModelEnabled (SIO-1235)", () => {
	test("defaults ON when unset", () => {
		expect(isSubAgentManifestModelEnabled({})).toBe(true);
	});

	test.each([
		["false", false],
		["0", false],
		["true", true],
		["1", true],
		["", true],
		["yes", true],
	])("SUB_AGENT_MANIFEST_MODEL_ENABLED=%s -> %s", (value, expected) => {
		expect(isSubAgentManifestModelEnabled({ SUB_AGENT_MANIFEST_MODEL_ENABLED: value })).toBe(expected);
	});
});

// SIO-1235: the invariant the new per-specialist lookup depends on. Every value in AGENT_NAMES
// must be a real key in the loaded subAgents map, or createLlm falls back to the root model and
// the specialist silently keeps running the wrong one -- the SIO-1229 failure mode.
describe("AGENT_NAMES all resolve to real sub-agent manifests (SIO-1235)", () => {
	const subAgents = loadAgent(join(import.meta.dir, "../../../agents/incident-analyzer")).subAgents;

	test("there are agent names to check", () => {
		expect(Object.keys(SUB_AGENT_NAMES).length).toBeGreaterThan(0);
	});

	test.each(Object.entries(SUB_AGENT_NAMES))("%s -> %s is a loaded sub-agent", (_dataSourceId, agentName) => {
		expect(subAgents.has(agentName), `${agentName} is not in the orchestrator's agents: map`).toBe(true);
		expect(subAgents.get(agentName)?.manifest.model?.preferred).toBeDefined();
	});
});

// SIO-1235 (CodeRabbit on PR #486): the light tier borrows the elastic-agent manifest and has no
// config of its own. If that manifest goes missing, resolveBedrockConfig does NOT throw -- it
// returns its built-in default (measured: eu.anthropic.claude-sonnet-4-6, not even the current
// root model), so every light-tier role would run a stale model while still logging
// source: "light-tier". These pin that the resolver reports light-tier provenance honestly.
describe("resolveRoleModelConfig provenance (SIO-1235)", () => {
	const agent = loadAgent(join(import.meta.dir, "../../../agents/incident-analyzer"));

	test("a light-tier role reports light-tier and borrows elastic-agent's model", () => {
		const resolved = resolveRoleModelConfig("classifier", agent);
		expect(resolved.source).toBe("light-tier");
		expect(resolved.modelConfig?.preferred).toBe(agent.subAgents.get("elastic-agent")?.manifest.model?.preferred);
	});

	test("a subAgent role with a known specialist reports sub-agent-manifest", () => {
		const resolved = resolveRoleModelConfig("subAgent", agent, "gitlab-agent");
		expect(resolved.source).toBe("sub-agent-manifest");
		expect(resolved.modelConfig?.preferred).toBe("claude-haiku-4-5");
	});

	test("a subAgent role with an unknown specialist reports root-manifest", () => {
		expect(resolveRoleModelConfig("subAgent", agent, "nope-agent").source).toBe("root-manifest");
	});

	test("a standard role reports root-manifest and ignores subAgentName", () => {
		const resolved = resolveRoleModelConfig("aggregator", agent, "gitlab-agent");
		expect(resolved.source).toBe("root-manifest");
		expect(resolved.modelConfig?.preferred).toBe(agent.manifest.model?.preferred);
	});

	// The light tier wins over the sub-agent branch: a role that is BOTH tierable-light and
	// passed a subAgentName must still resolve light, or flipping a role to light would be
	// silently overridden.
	test("light tier takes precedence over a sub-agent name", () => {
		expect(resolveRoleModelConfig("classifier", agent, "gitlab-agent").source).toBe("light-tier");
	});
});
