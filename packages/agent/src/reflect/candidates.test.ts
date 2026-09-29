// packages/agent/src/reflect/candidates.test.ts

// SIO-1893: create portfolio items become candidate drafts the ingest accepts.
import { describe, expect, test } from "bun:test";
import { LearningCandidateSchema } from "../skill-learner.ts";
import type { Analysis } from "./aggregate.ts";
import { reactedSessions, reflectCandidates, sharedTool, slug } from "./candidates.ts";
import type { Scan } from "./schema.ts";

const evidence = [
	{ session: "s1", message: 4, tool: "mcp_probe_unknown", excerpt: "tool mcp_probe_unknown failed: timeout after 30s" },
	{ session: "s2", message: 9, tool: "mcp_probe_unknown", excerpt: "tool mcp_probe_unknown failed: timeout after 30s" },
];

function analysis(over: Partial<Analysis> = {}): Analysis {
	return {
		schema: "reflect.analysis.v1" as Analysis["schema"],
		generatedAt: "2026-09-29T00:00:00.000Z",
		window: { hours: 168, since: "2026-09-22T00:00:00.000Z", until: "2026-09-29T00:00:00.000Z" },
		stats: { sessions: 2, headless: 0, signals: 2, high: 0, findings: 1, portfolio: 1, multiTurnSessions: 2 },
		datasources: [],
		findings: [
			{
				id: "F1",
				kind: "tool-failure",
				class: "gap",
				datasource: null,
				severity: "medium",
				recurrence: 2,
				count: 2,
				summary: "tool mcp_probe_unknown failed with timeout in 2 sessions",
				change: "add a skill that owns it",
				sessions: ["s1", "s2"],
				evidence,
			},
		],
		retries: [],
		portfolio: [
			{
				id: "PF1",
				action: "create",
				datasources: [],
				reason: "recurring tool-failure names no datasource, so nothing owns this gap",
				recurrence: 2,
				evidence,
				finding: "F1",
			},
		],
		notes: [],
		...over,
	};
}

describe("reflectCandidates (SIO-1893)", () => {
	test("a create item becomes a kind:skill candidate draft that the ingest schema accepts", () => {
		const out = reflectCandidates(analysis(), "2026-09-29");
		expect(out.skipped).toEqual([]);
		expect(out.candidates).toHaveLength(1);
		const c = out.candidates[0];
		expect(c).toMatchObject({
			kind: "skill",
			source: "reflect",
			status: "candidate",
			task_success: "",
			learned_from: "reflect:2026-09-29:F1",
			skill_name: "reflect-mcp-probe-unknown-f1",
		});
		expect(c?.title.length).toBeLessThanOrEqual(80);
		expect(c?.applicability.startsWith("When mcp_probe_unknown fails")).toBe(true);
		expect(c?.body).toContain("Do: before calling mcp_probe_unknown");
		expect(c?.body).not.toContain("add a skill");
		expect(c?.evidence[0]).toEqual({
			ref: "reflect:2026-09-29:F1:s1#4",
			excerpt: "tool mcp_probe_unknown failed: timeout after 30s",
		});
		expect(LearningCandidateSchema.omit({ agent: true }).safeParse(c).success).toBe(true);
	});

	test("a session with a negative user reaction files the item rejected with task_success 0", () => {
		const a = analysis();
		a.findings.push({
			id: "F2",
			kind: "user-redo",
			class: "quality",
			datasource: null,
			severity: "high",
			recurrence: 1,
			count: 1,
			summary: "user redid the request",
			change: "",
			sessions: ["s2"],
			evidence: [{ session: "s2", message: 12, tool: null, excerpt: "again please" }],
		});
		const c = reflectCandidates(a, "2026-09-29").candidates[0];
		expect(c).toMatchObject({ status: "rejected", task_success: "0", task_success_source: "reflect" });
	});

	// Greptile PR #921: a single-session reaction is not a finding, so the scans decide.
	test("a reaction seen in one session only, present in the scans, still rejects the draft", () => {
		const scan = {
			source: { host: "h", id: "s2", threadId: null, created: null, headless: false, datasources: [] },
			request: null,
			stats: { userMessages: 2 } as Scan["stats"],
			signals: [
				{
					id: "S1",
					kind: "user-handoff",
					severity: "high",
					summary: "handed off",
					count: 1,
					suspects: [],
					evidence: [],
				},
			],
			notes: [],
		} as unknown as Scan;
		expect([...reactedSessions(analysis(), [scan])]).toEqual(["s2"]);
		const c = reflectCandidates(analysis(), "2026-09-29", { scans: [scan] }).candidates[0];
		expect(c).toMatchObject({ status: "rejected", task_success: "0" });
		expect(reflectCandidates(analysis(), "2026-09-29").candidates[0]?.status).toBe("candidate");
	});

	// Greptile PR #921: two tools pooled into one finding are not one recurring tool.
	test("a draft names a tool only when every evidence entry shares it", () => {
		const a = analysis();
		const item = a.portfolio[0];
		if (!item) throw new Error("fixture");
		expect(sharedTool(item)).toBe("mcp_probe_unknown");
		const [first, second] = evidence;
		if (!first || !second) throw new Error("fixture");
		item.evidence = [first, { ...second, tool: "mcp_other_tool" }];
		expect(sharedTool(item)).toBeNull();
		const c = reflectCandidates(a, "x").candidates[0];
		expect(c?.skill_name).toBe("reflect-unattributed-tool-f1");
		expect(c?.applicability.startsWith("When an unattributed tool fails")).toBe(true);
		expect(c?.body).not.toContain("mcp_probe_unknown");
	});

	test("links by evidence when an older analysis carries no finding id; skips unlinked or evidence-less items", () => {
		const a = analysis();
		const item = a.portfolio[0];
		if (!item) throw new Error("fixture");
		item.finding = undefined;
		expect(reflectCandidates(a, "x").candidates).toHaveLength(1);
		item.evidence = [];
		const out = reflectCandidates(a, "x");
		expect(out.candidates).toHaveLength(0);
		expect(out.skipped[0]?.reason).toContain("no finding");
		a.portfolio = [{ id: "PF1", action: "merge", datasources: ["aws"], reason: "r", recurrence: 2, evidence }];
		expect(reflectCandidates(a, "x").skipped[0]?.reason).toContain("merge");
	});

	test("slug is kebab, bounded, never empty", () => {
		expect(slug(["reflect", "mcp_probe_unknown", "F1"])).toBe("reflect-mcp-probe-unknown-f1");
		expect(slug(["", ""])).toBe("reflect-lesson");
	});
});
