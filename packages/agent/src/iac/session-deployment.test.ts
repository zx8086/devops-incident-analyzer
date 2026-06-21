// agent/src/iac/session-deployment.test.ts
// SIO-1001: a terse gitops follow-up should inherit the deployment already established this session
// instead of the parser re-asking "which deployment?". These cover the pure, deterministic seams
// that drive that behavior: knownSessionDeployment (the fallback cascade + fresh-session guard) and
// isMissingClusterClarification (suppress ONLY a deployment-ask). The LLM/interrupt-driven back-fill
// inside parseIntent is exercised by the e2e replay in the PR verification.
import { describe, expect, test } from "bun:test";
import { isMissingClusterClarification, knownSessionDeployment } from "./nodes.ts";
import type { IacActiveChange, IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const ACTIVE = (deployment: string): IacActiveChange =>
	({
		deployment,
		stack: "lifecycle-policies",
		kind: "ilm-rollout",
		branch: "agent/x",
		updatedAtTurn: "req-1",
	}) as IacActiveChange;
const REQ = (cluster?: string): IacRequest => ({
	workflow: "ilm-rollout",
	isProd: false,
	...(cluster ? { cluster } : {}),
});

describe("knownSessionDeployment (SIO-1001)", () => {
	test("prefers activeChange.deployment", () => {
		const state = asIacState({
			activeChange: ACTIVE("us-cld"),
			targetDeployment: "eu-b2b",
			iacRequest: REQ("ap-cld"),
		});
		expect(knownSessionDeployment(state)).toBe("us-cld");
	});

	test("falls back to targetDeployment, then iacRequest.cluster", () => {
		expect(knownSessionDeployment(asIacState({ activeChange: null, targetDeployment: "eu-b2b" }))).toBe("eu-b2b");
		expect(knownSessionDeployment(asIacState({ activeChange: null, iacRequest: REQ("ap-cld") }))).toBe("ap-cld");
	});

	test("returns empty string on a fresh session (no deployment anywhere)", () => {
		expect(knownSessionDeployment(asIacState({}))).toBe("");
		expect(knownSessionDeployment(asIacState({ activeChange: null, targetDeployment: "", iacRequest: REQ() }))).toBe(
			"",
		);
	});

	test("ignores whitespace-only values", () => {
		expect(knownSessionDeployment(asIacState({ targetDeployment: "   " }))).toBe("");
	});
});

describe("isMissingClusterClarification (SIO-1001)", () => {
	test("matches a deployment/cluster ask", () => {
		expect(isMissingClusterClarification("Which deployment should this be applied to?")).toBe(true);
		expect(isMissingClusterClarification("What cluster do you mean?")).toBe(true);
	});

	test("does NOT match clarifications about other missing fields", () => {
		expect(isMissingClusterClarification("Which target version should I upgrade to?")).toBe(false);
		expect(isMissingClusterClarification("What tier and size do you want?")).toBe(false);
	});
});
