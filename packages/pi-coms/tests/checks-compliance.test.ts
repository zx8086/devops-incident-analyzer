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

// SIO-1868: churn classification. Wired into checkCompliance BEFORE
// collapseByRule, so a collapsed summary's count reflects what is reported.
function fakeTypedClient(pairs: { type: string; id: string }[], rule = "OrgConfigRule-required-tags-lf3sbwf9") {
	return {
		send: async (cmd: { constructor: { name: string } }) => {
			if (cmd.constructor.name === "DescribeComplianceByConfigRuleCommand") {
				return {
					ComplianceByConfigRules: [{ ConfigRuleName: rule, Compliance: { ComplianceType: "NON_COMPLIANT" } }],
				};
			}
			return {
				EvaluationResults: pairs.map((p) => ({
					EvaluationResultIdentifier: {
						EvaluationResultQualifier: { ConfigRuleName: rule, ResourceType: p.type, ResourceId: p.id },
					},
					ComplianceType: "NON_COMPLIANT",
				})),
			};
		},
	};
}

// Only the ids listed come back tagged; everything else is ABSENT from the
// response, exactly as the real API behaves for untagged or deleted resources.
function fakeTaggingFor(churnIds: string[]) {
	return {
		send: async (cmd: { input: { ResourceARNList?: string[] } }) => ({
			ResourceTagMappingList: (cmd.input.ResourceARNList ?? [])
				.filter((arn) => churnIds.includes(arn.slice(arn.lastIndexOf("/") + 1)))
				.map((arn) => ({ ResourceARN: arn, Tags: [{ Key: "karpenter.sh/nodepool", Value: "general-purpose" }] })),
		}),
	};
}

const CHURN_OPTS = {
	churnTagKeys: ["karpenter.sh/nodepool", "eks:eni:owner"],
	churnRulePatterns: ["required-tags"],
	region: "eu-central-1",
	accountId: "654654584630",
};

describe("checkCompliance churn classification (SIO-1868)", () => {
	const ENI = "AWS::EC2::NetworkInterface";

	function baselined(state: MonitorState, client: ReturnType<typeof fakeTypedClient>) {
		// The first successful read is the silent baseline; findings only appear on
		// the SECOND run, so every test here establishes the baseline first.
		return checkCompliance(client as never, state, { now: NOW });
	}

	test("drops a churn-owned resource and keeps an untagged one", async () => {
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		const client = fakeTypedClient([
			{ type: ENI, id: "eni-karpenter" },
			{ type: ENI, id: "eni-awsmanaged" },
		]);
		const findings = await checkCompliance(client as never, state, {
			now: NOW + 1000,
			...CHURN_OPTS,
			taggingClient: fakeTaggingFor(["eni-karpenter"]) as never,
		});
		const ids = findings.map((f) => (f.evidence as { resourceId?: string }).resourceId);
		expect(ids).toContain("eni-awsmanaged");
		expect(ids).not.toContain("eni-karpenter");
		state.close();
	});

	test("journals each drop in the ledger's shape so the weekly review sees it", async () => {
		// A silent drop is how accepted noise becomes forgotten noise.
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		await checkCompliance(fakeTypedClient([{ type: ENI, id: "eni-karpenter" }]) as never, state, {
			now: NOW + 1000,
			...CHURN_OPTS,
			taggingClient: fakeTaggingFor(["eni-karpenter"]) as never,
		});
		const rows = state.journalRows(60_000, "suppressed_finding");
		expect(rows).toHaveLength(1);
		const payload = JSON.parse(rows[0]?.payload ?? "{}");
		expect(payload.suppressed_by).toBe("churn-tag:autoscaler-owned");
		expect(payload.reason).toContain("ownership tag");
		expect(payload.dedup_key).toContain("eni-karpenter");
		state.close();
	});

	test("reports everything when the tag lookup fails", async () => {
		// Fail OPEN: a throttle must never suppress a real violation.
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		const findings = await checkCompliance(fakeTypedClient([{ type: ENI, id: "eni-karpenter" }]) as never, state, {
			now: NOW + 1000,
			...CHURN_OPTS,
			taggingClient: {
				send: async () => {
					throw new Error("Rate exceeded");
				},
			} as never,
		});
		const ids = findings.map((f) => (f.evidence as { resourceId?: string }).resourceId);
		expect(ids).toContain("eni-karpenter");
		// And it says so, rather than failing silently.
		const errs = state.journalRows(60_000, "check_error");
		expect(errs).toHaveLength(1);
		expect(JSON.parse(errs[0]?.payload ?? "{}").stage).toBe("churn-classification");
		state.close();
	});

	test("classifies BEFORE collapsing, so a collapsed count excludes churn", async () => {
		// Classifying afterwards would print "NON_COMPLIANT for 6 resources" while
		// reporting one: the summary would lie about its own contents.
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		const pairs = [
			...Array.from({ length: 5 }, (_, i) => ({ type: ENI, id: `eni-churn-${i}` })),
			...Array.from({ length: 4 }, (_, i) => ({ type: ENI, id: `eni-real-${i}` })),
		];
		const findings = await checkCompliance(fakeTypedClient(pairs) as never, state, {
			now: NOW + 1000,
			...CHURN_OPTS,
			taggingClient: fakeTaggingFor(pairs.filter((p) => p.id.includes("churn")).map((p) => p.id)) as never,
		});
		const batch = findings.find((f) => f.dedup_key.endsWith(":batch"));
		if (!batch) throw new Error("expected a collapsed batch finding");
		// 4 real ones collapse (>= COLLAPSE_AT), and the count is 4, not 9.
		expect(batch.summary).toContain("4 newly reported resource(s)");
		expect((batch.evidence as { count: number }).count).toBe(4);
		state.close();
	});

	test("is inert without a tagging client, keys, region or account", async () => {
		// Each of the four is required; missing any one must leave the check
		// behaving exactly as it did before this feature existed.
		for (const opts of [
			{},
			{ ...CHURN_OPTS },
			{ ...CHURN_OPTS, churnTagKeys: [], taggingClient: fakeTaggingFor(["eni-karpenter"]) as never },
			{ ...CHURN_OPTS, region: undefined, taggingClient: fakeTaggingFor(["eni-karpenter"]) as never },
			{ ...CHURN_OPTS, accountId: undefined, taggingClient: fakeTaggingFor(["eni-karpenter"]) as never },
		]) {
			const state = new MonitorState(":memory:");
			await baselined(state, fakeTypedClient([]));
			const findings = await checkCompliance(fakeTypedClient([{ type: ENI, id: "eni-karpenter" }]) as never, state, {
				now: NOW + 1000,
				...opts,
			});
			const ids = findings.map((f) => (f.evidence as { resourceId?: string }).resourceId);
			expect(ids).toContain("eni-karpenter");
			state.close();
		}
	});

	test("a rule OTHER than required-tags is never classified as churn", async () => {
		// Greptile P1 on #884. Ownership is a property of the resource, not the
		// rule: "this node churns" justifies ignoring a tagging violation on it and
		// does NOT justify ignoring a security finding on it. Before the rule gate,
		// securityhub-ec2-instance-multiple-eni-check -- live in
		// eu-mendix-platform-prd, and in the 2026-09-21 digest for this exact
		// instance -- was silently dropped on any Karpenter-owned node.
		const state = new MonitorState(":memory:");
		const rule = "securityhub-ec2-instance-multiple-eni-check-dd68747e";
		await checkCompliance(fakeTypedClient([], rule) as never, state, { now: NOW });
		const findings = await checkCompliance(
			fakeTypedClient([{ type: "AWS::EC2::Instance", id: "i-041d9a5923d4351a3" }], rule) as never,
			state,
			{ now: NOW + 1000, ...CHURN_OPTS, taggingClient: fakeTaggingFor(["i-041d9a5923d4351a3"]) as never },
		);
		expect(findings.map((f) => (f.evidence as { resourceId?: string }).resourceId)).toContain("i-041d9a5923d4351a3");
		// And it was not merely reported: nothing was suppressed at all.
		expect(state.journalRows(60_000, "suppressed_finding")).toHaveLength(0);
		state.close();
	});

	test("an empty rule-pattern list disables classification entirely", async () => {
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		const findings = await checkCompliance(fakeTypedClient([{ type: ENI, id: "eni-karpenter" }]) as never, state, {
			now: NOW + 1000,
			...CHURN_OPTS,
			churnRulePatterns: [],
			taggingClient: fakeTaggingFor(["eni-karpenter"]) as never,
		});
		expect(findings.map((f) => (f.evidence as { resourceId?: string }).resourceId)).toContain("eni-karpenter");
		state.close();
	});

	test("a resource type with no ARN mapping is reported unclassified", async () => {
		const state = new MonitorState(":memory:");
		await baselined(state, fakeTypedClient([]));
		const findings = await checkCompliance(
			fakeTypedClient([{ type: "AWS::CloudFormation::Stack", id: "stack-x" }]) as never,
			state,
			{ now: NOW + 1000, ...CHURN_OPTS, taggingClient: fakeTaggingFor(["stack-x"]) as never },
		);
		expect(findings.map((f) => (f.evidence as { resourceId?: string }).resourceId)).toContain("stack-x");
		state.close();
	});
});
