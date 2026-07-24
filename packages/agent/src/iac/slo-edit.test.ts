// agent/src/iac/slo-edit.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, normalizeSloTarget, parseIntentJson, reviewPlan, setSloOverrides } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// A real-shaped per-SLO file: inherits objective/time_window from _shared defaults (no override).
const SLO = JSON.stringify(
	{
		name: "SLO for monitor DS - API Health - prd | Authentication",
		description: "",
		space_id: "developer-experience",
		tags: ["production", "criticality:high"],
		indicator: {
			type: "synthetics_availability",
			monitor_id: "DS - API Health - prd | Authentication-eu-shared-services.prd-developer-experience",
			monitor_display_name: "DS - API Health - prd | Authentication",
		},
	},
	null,
	2,
);

// A per-SLO file that ALREADY overrides the target (to test previous-capture + no-op).
const SLO_WITH_TARGET = JSON.stringify(
	{ name: "x", space_id: "default", tags: [], indicator: { type: "kql_custom" }, objective: { target: 0.99 } },
	null,
	2,
);

describe("normalizeSloTarget", () => {
	test("treats a value > 1 as a percent", () => {
		expect(normalizeSloTarget(99.5)).toBe(0.995);
	});
	test("passes a fraction through", () => {
		expect(normalizeSloTarget(0.995)).toBe(0.995);
	});
	test("rounds float noise", () => {
		expect(normalizeSloTarget(99.95)).toBe(0.9995);
	});
	test("rejects <= 0 and > 100", () => {
		expect(normalizeSloTarget(0)).toBeNull();
		expect(normalizeSloTarget(-5)).toBeNull();
		expect(normalizeSloTarget(150)).toBeNull();
	});
});

describe("setSloOverrides", () => {
	test("sets objective.target as a nested-block override, capturing previous (undefined when inherited)", () => {
		const { content, previousTarget, changed } = setSloOverrides(SLO, { target: 0.995 });
		const parsed = JSON.parse(content) as { objective: { target: number } };
		expect(parsed.objective.target).toBe(0.995);
		expect(previousTarget).toBeUndefined(); // inherited from defaults; no prior file-level value
		expect(changed).toBe(true);
	});

	test("captures the previous target when the file already overrides it", () => {
		const { previousTarget } = setSloOverrides(SLO_WITH_TARGET, { target: 0.995 });
		expect(previousTarget).toBe(0.99);
	});

	test("sets time_window.duration and defaults type to rolling", () => {
		const { content } = setSloOverrides(SLO, { windowDuration: "60d" });
		const parsed = JSON.parse(content) as { time_window: { duration: string; type: string } };
		expect(parsed.time_window.duration).toBe("60d");
		expect(parsed.time_window.type).toBe("rolling");
	});

	test("replaces tags and captures the previous", () => {
		const { content, previousTags } = setSloOverrides(SLO, { tags: ["new", "tags"] });
		const parsed = JSON.parse(content) as { tags: string[] };
		expect(parsed.tags).toEqual(["new", "tags"]);
		expect(previousTags).toEqual(["production", "criticality:high"]);
	});

	test("leaves the indicator and name untouched", () => {
		const { content } = setSloOverrides(SLO, { target: 0.995 });
		const parsed = JSON.parse(content) as { name: string; indicator: { type: string } };
		expect(parsed.indicator.type).toBe("synthetics_availability");
		expect(parsed.name).toContain("Authentication");
	});

	test("preserves 2-space indent + trailing newline", () => {
		const { content } = setSloOverrides(SLO, { target: 0.995 });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "objective": {');
	});

	test("changed=false when no changes requested", () => {
		expect(setSloOverrides(SLO, {}).changed).toBe(false);
	});

	test("throws on non-object JSON", () => {
		expect(() => setSloOverrides("[]", { target: 0.99 })).toThrow("not an object");
	});
});

describe("parseIntentJson — slo-edit", () => {
	test("extracts workflow/cluster/sloName/sloTarget and does not clarify", () => {
		const raw = JSON.stringify({
			workflow: "slo-edit",
			cluster: "eu-b2b",
			sloName: "ds-authentication",
			sloTarget: 99.5,
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("slo-edit");
		expect(req.sloName).toBe("ds-authentication");
		expect(req.sloTarget).toBe(99.5);
		expect(req.clarification).toBeUndefined();
	});

	test("carries sloWindow + sloTags arrays, normalizing explicit nulls", () => {
		const raw = JSON.stringify({
			workflow: "slo-edit",
			cluster: "eu-b2b",
			sloName: "x",
			sloWindow: "60d",
			sloTags: ["a", "b"],
			tier: null,
		});
		const req = parseIntentJson(raw);
		expect(req.sloWindow).toBe("60d");
		expect(req.sloTags).toEqual(["a", "b"]);
		expect(req.tier).toBeUndefined();
	});
});

describe("branchSlug — slo-edit", () => {
	test("uses cluster + slo name + workflow", () => {
		const req: IacRequest = {
			workflow: "slo-edit",
			isProd: false,
			cluster: "eu-b2b",
			sloName: "ds-authentication",
			sloTarget: 0.995,
		};
		expect(branchSlug(req)).toBe("eu-b2b-ds-authentication-slo-edit");
	});
});

function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("draftChange -> proposeSloChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(SLO).toString("base64"), encoding: "base64" })}`;

	test("happy path: overrides target, commits, sets diff + precheckPassed", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "slo-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				sloName: "ds-authentication",
				sloTarget: 99.5,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/slos/ds-authentication.json");
		expect(result.proposedDiff).toContain('"target"');
		expect(result.proposedDiff).toContain("0.995");
		expect(result.sloTargetLowered).toBe(false); // inherited default unknown -> not flagged
		const written = JSON.parse(String(committed.content)) as { objective: { target: number } };
		expect(written.objective.target).toBe(0.995);
	});

	test("flags a LOWERED target when the file already had a higher one", async () => {
		const { draftChange } = await import("./nodes.ts");
		const withHigh = `[200] ${JSON.stringify({ content: Buffer.from(SLO_WITH_TARGET).toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: () => withHigh,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "x", sloTarget: 0.95 },
		};
		const result = await draftChange(asIacState(state));
		expect(result.sloTargetLowered).toBe(true); // 0.99 -> 0.95
	});

	test("blocks when no SLO name or no change field", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "x" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("at least one of target");
	});

	test("blocks on an invalid target", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "x", sloTarget: 150 },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("Invalid SLO target");
	});

	test("blocks (no create) when the SLO file 404s", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "nope", sloTarget: 0.99 },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("not found");
	});

	test("no-op guard: blocks when already at the requested target", async () => {
		const { draftChange } = await import("./nodes.ts");
		const withTarget = `[200] ${JSON.stringify({ content: Buffer.from(SLO_WITH_TARGET).toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: () => withTarget,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "x", sloTarget: 0.99 },
		};
		const result = await draftChange(asIacState(state));
		// SIO-1020: a no-op surfaces as noopReason (neutral "No change needed"), not blockedReason.
		expect(result.noopReason).toContain("already has the requested values");
		expect(String(result.messages?.[0]?.content ?? "")).toContain("REPO file only"); // SIO-1196
		expect(result.blockedReason).toBeFalsy();
	});
});

describe("reviewPlan — slo-edit", () => {
	test("config-edit kind, slo risk line, descriptor in title", async () => {
		const state = {
			iacRequest: {
				workflow: "slo-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				sloName: "ds-authentication",
				sloTarget: 0.995,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			sloTargetLowered: false,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("ds-authentication");
		expect(result.planReview?.title).toContain("slo-edit");
		expect(result.risks?.some((r) => r.includes("error-budget"))).toBe(true);
	});

	test("a lowered target surfaces a leading risk line", async () => {
		const state = {
			iacRequest: { workflow: "slo-edit" as const, isProd: false, cluster: "eu-b2b", sloName: "x", sloTarget: 0.9 },
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			sloTargetLowered: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.[0]).toContain("LOWERED");
	});
});
