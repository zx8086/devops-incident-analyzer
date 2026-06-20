// agent/src/iac/amend.test.ts
// SIO-990: the correction/amend lane. A follow-up that corrects the change just proposed this
// session re-commits onto the SAME branch (updating the existing MR in place) instead of proposing
// from scratch. These cover the pure, deterministic seams: resolveBranch (branch pinning) and
// classifyIacIntent's pre-LLM correction guard (routing to gitops-amend only when an activeChange
// exists). The HTTP/LLM-driven parts are exercised by the e2e replay in the PR verification.
import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { classifyIacIntent, resolveBranch } from "./nodes.ts";
import type { IacActiveChange, IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const ILM_REQ: IacRequest = {
	workflow: "ilm-rollout",
	cluster: "eu-b2b",
	policyName: "metrics-apm.app_metrics-default_policy",
	isProd: false,
};

// A branch from a PRIOR day so the "fresh gitops turn uses branchName" assertion can't collide with
// today's deterministic branchName(req) (same-day same-slug correctly resolves to the same branch --
// that is the in-place-update property, exercised by the pin test, not this distinctness check).
const ACTIVE: IacActiveChange = {
	deployment: "eu-b2b",
	stack: "lifecycle-policies",
	kind: "ilm-rollout",
	branch: "agent/eu-b2b-metrics-apm-app-metrics-default-p-20000101",
	proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics-apm.app_metrics-default_policy.json"],
	mrUrl: "https://gitlab.com/x/-/merge_requests/189",
	mrIid: 189,
	updatedAtTurn: "req-1",
};

describe("resolveBranch (SIO-990)", () => {
	test("pins to the active change's branch on an amend", () => {
		const state = asIacState({ intent: "gitops-amend", activeChange: ACTIVE });
		expect(resolveBranch(state, ILM_REQ)).toBe(ACTIVE.branch);
	});

	test("uses branchName(req) on a fresh gitops turn (no pin)", () => {
		const state = asIacState({ intent: "gitops", activeChange: ACTIVE });
		const branch = resolveBranch(state, ILM_REQ);
		expect(branch).not.toBe(ACTIVE.branch);
		// Derived slug shape: agent/<cluster>-<policy-slug>-<date>.
		expect(branch.startsWith("agent/eu-b2b-")).toBe(true);
	});

	test("falls back to branchName when amending but no activeChange branch is set", () => {
		const state = asIacState({ intent: "gitops-amend", activeChange: null });
		expect(resolveBranch(state, ILM_REQ).startsWith("agent/")).toBe(true);
	});
});

describe("classifyIacIntent correction guard (SIO-990)", () => {
	// The correction guard is pre-LLM, so these resolve synchronously without any model call.
	const human = (text: string) => new HumanMessage(text);

	test("routes a correction to gitops-amend when an activeChange exists", async () => {
		const state = asIacState({
			activeChange: ACTIVE,
			messages: [human("do as instructed -> change delete.min_age to 14d")],
		});
		const out = await classifyIacIntent(state);
		expect(out.intent).toBe("gitops-amend");
	});

	test("a bare 'proceed' after a proposal amends rather than re-proposing", async () => {
		const state = asIacState({ activeChange: ACTIVE, messages: [human("proceed")] });
		const out = await classifyIacIntent(state);
		expect(out.intent).toBe("gitops-amend");
	});

	// Note: the "no activeChange -> guard skipped" case falls through to the classifier LLM, so it is
	// covered by looksLikeCorrection's unit tests (classify.test.ts) rather than a networked call here.
});
