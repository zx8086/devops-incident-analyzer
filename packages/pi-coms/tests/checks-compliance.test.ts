// tests/checks-compliance.test.ts
import { describe, expect, test } from "bun:test";
import { checkCompliance } from "../scripts/monitor/checks/compliance.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-14T12:00:00Z");

// rules: rule name -> NON_COMPLIANT resource ids ("deny" makes the detail read
// throw for that rule, as a rule outside the granted reads would).
function fakeClient(rules: Record<string, string[] | "deny">) {
	return {
		send: async (cmd: { constructor: { name: string }; input: { ConfigRuleName?: string } }) => {
			if (cmd.constructor.name === "DescribeComplianceByConfigRuleCommand") {
				return {
					ComplianceByConfigRules: Object.keys(rules).map((name) => ({
						ConfigRuleName: name,
						Compliance: { ComplianceType: "NON_COMPLIANT" },
					})),
				};
			}
			const ids = rules[cmd.input.ConfigRuleName ?? ""];
			if (ids === "deny") throw new Error("AccessDeniedException");
			return {
				EvaluationResults: (ids ?? []).map((id) => ({
					EvaluationResultIdentifier: {
						EvaluationResultQualifier: {
							ConfigRuleName: cmd.input.ConfigRuleName,
							ResourceType: "AWS::EC2::SecurityGroup",
							ResourceId: id,
						},
					},
					ComplianceType: "NON_COMPLIANT",
				})),
			};
		},
	};
}

describe("checkCompliance (SIO-1740)", () => {
	test("the first run only establishes the snapshot; a newly non-compliant resource is one warn", async () => {
		const state = new MonitorState(":memory:");
		expect(await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"] }), state, { now: NOW })).toHaveLength(0);
		expect(await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"] }), state, { now: NOW })).toHaveLength(0);
		const out = await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1", "sg-2"] }), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			family: "compliance",
			severity: "warn",
			resource: "AWS::EC2::SecurityGroup/sg-2",
			dedup_key: "compliance:restricted-rdp:sg-2",
		});
		expect(out[0].summary).toContain("restricted-rdp NON_COMPLIANT");
	});

	test("a resource back in compliance is info; a rule that disappears resolves all its resources", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"], "access-keys-rotated": ["u1"] }), state, {
			now: NOW,
		});
		const out = await checkCompliance(fakeClient({ "restricted-rdp": [] }), state, { now: NOW });
		expect(out).toHaveLength(2);
		expect(out.every((f) => f.severity === "info")).toBe(true);
		expect(out.map((f) => f.resource).sort()).toEqual(["AWS::EC2::SecurityGroup/sg-1", "AWS::EC2::SecurityGroup/u1"]);
	});

	test("a rule whose details cannot be read keeps its pairs and says so once a day", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"] }), state, { now: NOW });
		const out = await checkCompliance(fakeClient({ "restricted-rdp": "deny" }), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ severity: "info", dedup_key: "compliance:error:restricted-rdp" });
		// sg-1 did not read as resolved, and the error does not repeat.
		expect(await checkCompliance(fakeClient({ "restricted-rdp": "deny" }), state, { now: NOW })).toHaveLength(0);
		expect(await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"] }), state, { now: NOW })).toHaveLength(0);
	});

	test("a mass flip is capped with an overflow count", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ r: [] }), state, { now: NOW });
		const many = Array.from({ length: 25 }, (_, i) => `sg-${i}`);
		const out = await checkCompliance(fakeClient({ r: many }), state, { now: NOW, warnCap: 20 });
		expect(out.filter((f) => f.severity === "warn")).toHaveLength(20);
		const overflow = out.find((f) => f.dedup_key.startsWith("compliance:overflow:"));
		expect(overflow?.summary).toContain("5 more resource(s)");
	});
});
