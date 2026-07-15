// packages/agent/src/aws-policy-actions.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _grantedActionsForTest, extractIamActions, isGrantedAction } from "./aws-policy-actions.ts";

// SIO-1120: the frozen GRANTED_ACTIONS set must stay in parity with the two committed policy
// JSON files. Reading them here (test-time only) means any future policy edit that doesn't update
// the frozen set fails CI rather than silently letting the grounding guard use a stale grant list.
interface PolicyDoc {
	Statement: Array<{ Action: string[] }>;
}

// The worktree root is four levels up from packages/agent/src.
const POLICY_DIR = join(import.meta.dir, "..", "..", "..", "scripts", "agentcore", "policies");

async function actionsFromPolicy(fileName: string): Promise<string[]> {
	const doc = (await Bun.file(join(POLICY_DIR, fileName)).json()) as PolicyDoc;
	return doc.Statement.flatMap((s) => s.Action).map((a) => a.toLowerCase());
}

describe("aws-policy-actions parity with committed policy JSON", () => {
	test("every action in both policies is in the frozen granted set", async () => {
		const base = await actionsFromPolicy("devops-agent-readonly-policy.json");
		const troubleshooting = await actionsFromPolicy("devops-agent-readonly-troubleshooting-policy.json");
		const fromJson = new Set([...base, ...troubleshooting]);

		const frozen = _grantedActionsForTest();
		const missing = [...fromJson].filter((a) => !frozen.has(a));
		expect(missing).toEqual([]);
	});

	test("the frozen set has no extra actions beyond the two policies", async () => {
		const base = await actionsFromPolicy("devops-agent-readonly-policy.json");
		const troubleshooting = await actionsFromPolicy("devops-agent-readonly-troubleshooting-policy.json");
		const fromJson = new Set([...base, ...troubleshooting]);

		const extra = [..._grantedActionsForTest()].filter((a) => !fromJson.has(a));
		expect(extra).toEqual([]);
	});
});

describe("isGrantedAction", () => {
	test("recognizes base-policy network topology reads (case-insensitive)", () => {
		expect(isGrantedAction("ec2:DescribeRouteTables")).toBe(true);
		expect(isGrantedAction("EC2:DESCRIBEVPCENDPOINTS")).toBe(true);
	});
	test("recognizes troubleshooting-policy network-path reads", () => {
		expect(isGrantedAction("ec2:DescribeNatGateways")).toBe(true);
		expect(isGrantedAction("ec2:DescribeFlowLogs")).toBe(true);
		expect(isGrantedAction("kafka:DescribeClusterV2")).toBe(true);
	});
	test("rejects a write action and an unrelated read", () => {
		expect(isGrantedAction("ec2:TerminateInstances")).toBe(false);
		expect(isGrantedAction("ec2:DescribeSpotFleetRequests")).toBe(false);
	});
});

describe("extractIamActions", () => {
	test("pulls a service:Action token out of a sentence", () => {
		expect(extractIamActions('Update DevOpsAgentReadOnlyPolicy to include "ec2:DescribeRouteTables".')).toEqual([
			"ec2:describeroutetables",
		]);
	});
	test("pulls multiple tokens and lowercases them", () => {
		expect(
			extractIamActions("Requires ec2:DescribeVpcEndpoints and ec2:DescribeRouteTables — currently not permitted"),
		).toEqual(["ec2:describevpcendpoints", "ec2:describeroutetables"]);
	});
	test("handles hyphenated service names", () => {
		expect(extractIamActions("network-firewall:DescribeFirewall was denied")).toEqual([
			"network-firewall:describefirewall",
		]);
	});
	test("returns empty when no action token is present", () => {
		expect(extractIamActions("The route table data was not retrieved this turn.")).toEqual([]);
	});
});
