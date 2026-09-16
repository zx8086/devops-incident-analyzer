// tests/checks-compliance.test.ts
import { describe, expect, test } from "bun:test";
import { checkCompliance, collapseByRule } from "../scripts/monitor/checks/compliance.ts";
import type { Finding } from "../scripts/monitor/report.ts";
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

	test("a pair that vanishes is info worded as no-longer-reported, never as verified compliance", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"], "access-keys-rotated": ["u1"] }), state, {
			now: NOW,
		});
		const out = await checkCompliance(fakeClient({ "restricted-rdp": [] }), state, { now: NOW });
		expect(out).toHaveLength(2);
		expect(out.every((f) => f.severity === "info")).toBe(true);
		expect(out.map((f) => f.resource).sort()).toEqual(["AWS::EC2::SecurityGroup/sg-1", "AWS::EC2::SecurityGroup/u1"]);
		for (const f of out) {
			expect(f.summary).toContain("no longer reports");
			expect(f.summary).not.toContain("back in compliance");
			expect(f.evidence).toMatchObject({ verified: false });
		}
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
		// The cap is across rules; collapse (SIO-1758) is switched off to isolate it.
		const out = await checkCompliance(fakeClient({ r: many }), state, {
			now: NOW,
			warnCap: 20,
			collapseAt: Number.POSITIVE_INFINITY,
		});
		expect(out.filter((f) => f.severity === "warn")).toHaveLength(20);
		const overflow = out.find((f) => f.dedup_key.startsWith("compliance:overflow:"));
		expect(overflow?.summary).toContain("5 more resource(s)");
		// The cap hides them from the report, never from the journal.
		const omitted = ((overflow?.evidence ?? {}) as { omitted?: { resourceId: string }[] }).omitted ?? [];
		expect(omitted.map((o) => o.resourceId)).toEqual(["sg-20", "sg-21", "sg-22", "sg-23", "sg-24"]);
	});

	// Review finding on #774: a rule whose first read fails must not persist an
	// empty baseline, or its standing violations all read as new once it reads.
	test("a rule unreadable on its first appearance establishes its baseline silently when it becomes readable", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ other: ["x1"] }), state, { now: NOW });
		const denied = await checkCompliance(fakeClient({ other: ["x1"], "restricted-rdp": "deny" }), state, { now: NOW });
		expect(denied.map((f) => f.dedup_key)).toEqual(["compliance:error:restricted-rdp"]);
		// First complete read: the two standing violations are the baseline.
		const first = await checkCompliance(fakeClient({ other: ["x1"], "restricted-rdp": ["sg-1", "sg-2"] }), state, {
			now: NOW,
		});
		expect(first).toHaveLength(0);
		// From here on a genuinely new pair is a finding again.
		const next = await checkCompliance(
			fakeClient({ other: ["x1"], "restricted-rdp": ["sg-1", "sg-2", "sg-3"] }),
			state,
			{
				now: NOW,
			},
		);
		expect(next.map((f) => f.dedup_key)).toEqual(["compliance:restricted-rdp:sg-3"]);
	});

	// Second review round on #774: initialization must outlive the pairs.
	test("an initialized rule whose violations cleared still reports a new one after a transient read failure", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ "restricted-rdp": ["sg-1"], other: ["x1"] }), state, { now: NOW });
		// Cleared: the rule is no longer NON_COMPLIANT at all.
		expect((await checkCompliance(fakeClient({ other: ["x1"] }), state, { now: NOW })).map((f) => f.severity)).toEqual([
			"info",
		]);
		// A new violation appears but the detail read fails this run.
		const denied = await checkCompliance(fakeClient({ "restricted-rdp": "deny", other: ["x1"] }), state, { now: NOW });
		expect(denied.map((f) => f.dedup_key)).toEqual(["compliance:error:restricted-rdp"]);
		// The retry must report it: this rule was initialized long ago.
		const out = await checkCompliance(fakeClient({ "restricted-rdp": ["sg-2"], other: ["x1"] }), state, { now: NOW });
		expect(out.map((f) => f.dedup_key)).toEqual(["compliance:restricted-rdp:sg-2"]);
	});

	test("a rule seen NON_COMPLIANT for the first time after the first run reports its pairs", async () => {
		const state = new MonitorState(":memory:");
		await checkCompliance(fakeClient({ other: ["x1"] }), state, { now: NOW });
		const out = await checkCompliance(fakeClient({ other: ["x1"], "restricted-rdp": ["sg-1"] }), state, { now: NOW });
		expect(out.map((f) => f.dedup_key)).toEqual(["compliance:restricted-rdp:sg-1"]);
	});
});

// SIO-1758: the rule/type counts are the real ones from the eu-mendix-platform-prd
// report of 2026-09-16 09:07 (a Karpenter consolidation): 84 new pairs under two
// rules and 30 cleared, delivered then as 51 findings (20 warn, 1 overflow, 30
// info). Resource ids are placeholders; the shape is the pair finding the diff emits.
describe("collapseByRule (SIO-1758)", () => {
	const at = "2026-09-16T09:07:00.000Z";
	const TAGS = "OrgConfigRule-required-tags-lf3sbwf9";
	const ENI = "securityhub-ec2-instance-multiple-eni-check-dd68747e";
	const pair = (severity: "warn" | "info", rule: string, resourceType: string, i: number): Finding => ({
		family: "compliance",
		severity,
		resource: `${resourceType}/${resourceType}-${i}`,
		summary: `pair ${rule} ${resourceType} ${i}`,
		dedup_key: `compliance:${rule}:${resourceType}-${i}`,
		evidence: { rule, resourceType, resourceId: `${resourceType}-${i}` },
		at,
	});
	const many = (severity: "warn" | "info", rule: string, type: string, n: number) =>
		Array.from({ length: n }, (_, i) => pair(severity, rule, type, i));
	const churn: Finding[] = [
		...many("warn", TAGS, "AWS::EC2::Instance", 13),
		...many("warn", TAGS, "AWS::EC2::NetworkInterface", 40),
		...many("warn", TAGS, "AWS::EC2::Volume", 18),
		...many("warn", ENI, "AWS::EC2::Instance", 13),
		...many("info", TAGS, "AWS::EC2::Instance", 13),
		...many("info", TAGS, "AWS::EC2::NetworkInterface", 2),
		...many("info", TAGS, "AWS::EC2::Volume", 2),
		...many("info", ENI, "AWS::EC2::Instance", 13),
	];

	test("the mendix consolidation becomes one new and one cleared finding per rule", () => {
		const out = collapseByRule(churn, at);
		expect(out).toHaveLength(4);
		const tags = out.find((f) => f.severity === "warn" && f.resource === `config-rule/${TAGS}`);
		expect(tags?.summary).toBe(
			`Config rule ${TAGS} NON_COMPLIANT for 71 newly reported resource(s): 40 AWS::EC2::NetworkInterface, 18 AWS::EC2::Volume, 13 AWS::EC2::Instance`,
		);
		expect(tags?.dedup_key).toBe(`compliance:${TAGS}:batch`);
		// The prompt gets per-type counts and a bounded sample, never all 71 ids.
		expect(tags?.evidence).toMatchObject({
			count: 71,
			byType: { "AWS::EC2::NetworkInterface": 40, "AWS::EC2::Volume": 18, "AWS::EC2::Instance": 13 },
			omitted: 46,
		});
		expect(tags?.evidence).toHaveProperty("resources.length", 25);
		const cleared = out.find((f) => f.severity === "info" && f.resource === `config-rule/${TAGS}`);
		expect(cleared?.evidence).toMatchObject({ count: 17, verified: false });
	});

	test("a lone flip keeps its own line and key", () => {
		const rdp = pair("warn", "OrgConfigRule-restricted-rdp", "AWS::EC2::SecurityGroup", 1);
		expect(collapseByRule([rdp], at)).toEqual([rdp]);
	});

	test("below the threshold a rule stays per pair; at it, it collapses", () => {
		expect(collapseByRule(many("warn", TAGS, "AWS::EC2::Volume", 3), at)).toHaveLength(3);
		expect(collapseByRule(many("warn", TAGS, "AWS::EC2::Volume", 4), at)).toHaveLength(1);
	});

	test("findings without a rule pass through untouched", () => {
		const unreadable: Finding = {
			family: "compliance",
			severity: "info",
			resource: TAGS,
			summary: `Config rule ${TAGS} details not readable: Rate exceeded`,
			dedup_key: `compliance:error:${TAGS}`,
			evidence: { error: "Rate exceeded" },
			at,
		};
		expect(collapseByRule([unreadable, ...many("info", TAGS, "AWS::EC2::Volume", 5)], at)).toHaveLength(2);
	});
});
