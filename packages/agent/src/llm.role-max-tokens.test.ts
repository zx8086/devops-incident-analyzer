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

		const roles = [...LONG_FORM_ROLES].filter((r) =>
			agent.name === "elastic-iac" ? IAC_ROLES.has(r) : !IAC_ROLES.has(r),
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
