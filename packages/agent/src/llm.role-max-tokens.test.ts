// agent/src/llm.role-max-tokens.test.ts
//
// SIO-1225: locks every long-output role's token budget to the measured truncation floor of the
// model it actually runs on. Free and offline -- it reads the declared MODEL_REGISTRY
// capabilities (SIO-1223), which are in turn backed by the committed probe reports (SIO-1224).
//
// This is the regression guard for a failure mode with no error message: when a role's budget
// is below what the model needs, the answer is silently cut off. SIO-649 was that failure for
// the aggregator (a report truncated before its mandatory trailing Confidence line, leaving the
// HITL gate a 0 score); SIO-1224's probe found Sonnet 5 reproducing it at 4096, a budget that
// was ample for the previous generation.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent, resolveBedrockConfig, resolveFallbackConfig } from "@devops-agent/gitagent-bridge";
import { type LlmRole, LONG_FORM_ROLES, ROLE_OVERRIDES } from "./llm.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");

const AGENTS = [
	{ name: "incident-analyzer", dir: join(REPO_ROOT, "agents/incident-analyzer") },
	{ name: "elastic-iac", dir: join(REPO_ROOT, "agents/elastic-iac") },
] as const;

// Which roles belong to which graph. A role is only budgeted against the model of the agent
// that actually constructs it.
const IAC_ROLES = new Set<LlmRole>(["iacPlanner", "iacDrafter", "iacReviewer", "iacClassifier", "iacReader"]);

describe("long-form roles clear the model's measured truncation floor", () => {
	for (const agent of AGENTS) {
		const manifest = loadAgent(agent.dir).manifest.model;
		const primary = resolveBedrockConfig(manifest);
		const fallback = resolveFallbackConfig(manifest);

		// The binding requirement is the WORST floor in the chain, not the primary's. iacReader
		// runs on Opus 4.8 (floor 4096) but falls back to Sonnet 5 (floor 8192): budgeting for
		// the primary alone means the answer truncates precisely when the fallback engages --
		// the failure a fallback exists to prevent.
		const floor = Math.max(primary.capabilities.longFormMinTokens, fallback?.capabilities.longFormMinTokens ?? 0);

		// SIO-1235: subAgent is excluded here and budgeted separately below. It no longer resolves
		// from the ROOT manifest chain -- each specialist now runs its own manifest's model -- so
		// checking it against root's floor would validate a chain it never uses. It happens to pass
		// either way today (root floor 8192, haiku floor 4096, budget 8192), which is exactly why
		// leaving it here would be a silent trap the next time either model moves.
		const roles = [...LONG_FORM_ROLES].filter(
			(r) => r !== "subAgent" && (agent.name === "elastic-iac" ? IAC_ROLES.has(r) : !IAC_ROLES.has(r)),
		);

		test(`${agent.name}: floor is derived from the whole chain, not just the primary`, () => {
			expect(floor).toBeGreaterThan(0);
			expect(roles.length).toBeGreaterThan(0);
		});

		for (const role of roles) {
			test(`${agent.name}/${role} budget >= ${floor} (${primary.model}${fallback ? ` -> ${fallback.model}` : ""})`, () => {
				const effective = ROLE_OVERRIDES[role].maxTokens ?? primary.maxTokens;
				expect(effective, `${role} would truncate a long answer on this chain`).toBeGreaterThanOrEqual(floor);
			});
		}
	}

	// SIO-1235: subAgent now resolves per-specialist, so its budget must clear the floor of EVERY
	// sub-agent manifest -- not the root manifest's. This is the check that starts failing if one
	// specialist's yaml is bumped to a model with a higher truncation floor than
	// ROLE_OVERRIDES.subAgent budgets for, which is precisely the per-agent tuning this ticket
	// makes a one-line edit.
	const subAgents = [...loadAgent(join(REPO_ROOT, "agents/incident-analyzer")).subAgents.entries()];

	test("sub-agent manifests are discoverable (anti-vacuity for the loop below)", () => {
		expect(subAgents.length).toBeGreaterThan(0);
	});

	for (const [name, sub] of subAgents) {
		const primary = resolveBedrockConfig(sub.manifest.model);
		const fallback = resolveFallbackConfig(sub.manifest.model);
		// Sub-agent manifests declare no `fallback:` today, so this is the primary's floor -- but
		// derive it from the chain anyway so adding one later is automatically covered.
		const floor = Math.max(primary.capabilities.longFormMinTokens, fallback?.capabilities.longFormMinTokens ?? 0);

		test(`${name}/subAgent budget >= ${floor} (${primary.model})`, () => {
			const effective = ROLE_OVERRIDES.subAgent.maxTokens ?? primary.maxTokens;
			expect(effective, `subAgent would truncate a long answer on ${name}'s model`).toBeGreaterThanOrEqual(floor);
		});
	}

	// Guards the set itself: a role added to LONG_FORM_ROLES with no measured basis, or a typo,
	// should not silently pass by resolving to undefined.
	test("every LONG_FORM_ROLES member is a real role in ROLE_OVERRIDES", () => {
		for (const role of LONG_FORM_ROLES) {
			expect(ROLE_OVERRIDES[role], `${role} is not a known role`).toBeDefined();
		}
	});

	// The short-output complement must stay OUT, or the floor would inflate budgets that are
	// deliberately small (iacClassifier answers with a single word on a 16-token cap).
	test("deliberately short-output roles are excluded", () => {
		for (const role of ["iacClassifier", "awsEstateRouter", "followUp", "gapsJudge", "absenceJudge"] as LlmRole[]) {
			expect(LONG_FORM_ROLES.has(role), `${role} must not be treated as long-form`).toBe(false);
		}
	});
});
