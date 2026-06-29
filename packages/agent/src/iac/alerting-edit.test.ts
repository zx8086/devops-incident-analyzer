// agent/src/iac/alerting-edit.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson, reviewPlan, setAlertingFields } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// A real-shaped apm.transaction_error_rate rule.
const RULE = JSON.stringify(
	{
		name: "MarTech_Add_To_Wallet_Transactions_Failed_Status_PRD",
		rule_type_id: "apm.transaction_error_rate",
		consumer: "alerts",
		enabled: true,
		interval: "5m",
		space_id: "default",
		rule_id: "444225ba-3df6-4e40-a774-ff1a327a8d3c",
		params: { serviceName: "martech-add-to-wallet", threshold: 1, windowSize: 5, windowUnit: "m" },
		actions: [{ group: "threshold_met", id: "28d2e7a2-bdbc-49bf-ba30-21487076ed1c", params: { body: { x: 1 } } }],
	},
	null,
	2,
);

describe("setAlertingFields", () => {
	test("sets params.threshold, captures previous, preserves actions + other params", () => {
		const { content, previousThreshold, changed } = setAlertingFields(RULE, { threshold: 5 });
		const parsed = JSON.parse(content) as {
			params: { threshold: number; serviceName: string };
			actions: unknown[];
		};
		expect(parsed.params.threshold).toBe(5);
		expect(parsed.params.serviceName).toBe("martech-add-to-wallet"); // untouched
		expect(parsed.actions).toHaveLength(1); // connector wiring untouched
		expect(previousThreshold).toBe(1);
		expect(changed).toBe(true);
	});

	test("sets windowSize + windowUnit", () => {
		const { content } = setAlertingFields(RULE, { windowSize: 10, windowUnit: "h" });
		const parsed = JSON.parse(content) as { params: { windowSize: number; windowUnit: string } };
		expect(parsed.params.windowSize).toBe(10);
		expect(parsed.params.windowUnit).toBe("h");
	});

	test("disables the rule and captures previousEnabled", () => {
		const { content, previousEnabled } = setAlertingFields(RULE, { enabled: false });
		const parsed = JSON.parse(content) as { enabled: boolean };
		expect(parsed.enabled).toBe(false);
		expect(previousEnabled).toBe(true);
	});

	test("sets interval and captures previous", () => {
		const { content, previousInterval } = setAlertingFields(RULE, { interval: "1m" });
		const parsed = JSON.parse(content) as { interval: string };
		expect(parsed.interval).toBe("1m");
		expect(previousInterval).toBe("5m");
	});

	test("leaves the notification template (params.body via actions) untouched", () => {
		const { content } = setAlertingFields(RULE, { threshold: 5 });
		const parsed = JSON.parse(content) as { actions: Array<{ params: { body: { x: number } } }> };
		expect(parsed.actions[0]?.params.body.x).toBe(1);
	});

	test("preserves 2-space indent + trailing newline", () => {
		const { content } = setAlertingFields(RULE, { threshold: 5 });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "params": {');
	});

	test("changed=false when nothing requested", () => {
		expect(setAlertingFields(RULE, {}).changed).toBe(false);
	});

	test("throws on non-object JSON", () => {
		expect(() => setAlertingFields("[]", { threshold: 1 })).toThrow("not an object");
	});
});

describe("parseIntentJson — alerting-edit", () => {
	test("extracts workflow/cluster/ruleName/alertThreshold and does not clarify", () => {
		const raw = JSON.stringify({
			workflow: "alerting-edit",
			cluster: "eu-b2b",
			ruleName: "default__martech_add_to_wallet_transactions_failed_status_prd",
			alertThreshold: 5,
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("alerting-edit");
		expect(req.ruleName).toContain("martech_add_to_wallet");
		expect(req.alertThreshold).toBe(5);
		expect(req.clarification).toBeUndefined();
	});

	test("carries alertEnabled:false + window, normalizing explicit nulls", () => {
		const raw = JSON.stringify({
			workflow: "alerting-edit",
			cluster: "eu-b2b",
			ruleName: "default__x",
			alertEnabled: false,
			alertWindowSize: 10,
			alertWindowUnit: "m",
			tier: null,
		});
		const req = parseIntentJson(raw);
		expect(req.alertEnabled).toBe(false);
		expect(req.alertWindowSize).toBe(10);
		expect(req.alertWindowUnit).toBe("m");
		expect(req.tier).toBeUndefined();
	});
});

describe("branchSlug — alerting-edit", () => {
	test("uses cluster + rule name + workflow", () => {
		const req: IacRequest = {
			workflow: "alerting-edit",
			isProd: false,
			cluster: "eu-b2b",
			ruleName: "default__cart_failed",
			alertThreshold: 5,
		};
		expect(branchSlug(req)).toBe("eu-b2b-default-cart-failed-alerting-edit");
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

describe("draftChange -> proposeAlertingChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(RULE).toString("base64"), encoding: "base64" })}`;

	test("happy path: raises threshold, commits, sets diff + precheckPassed", async () => {
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
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__martech_add_to_wallet_transactions_failed_status_prd",
				alertThreshold: 5,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe(
			"environments/eu-b2b/alerting/default__martech_add_to_wallet_transactions_failed_status_prd.json",
		);
		expect(result.proposedDiff).toContain('"threshold"');
		expect(result.proposedDiff).toContain("5");
		expect(result.alertDisabled).toBe(false);
		const written = JSON.parse(String(committed.content)) as { params: { threshold: number } };
		expect(written.params.threshold).toBe(5);
	});

	test("disabling a rule flags alertDisabled", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__x",
				alertEnabled: false,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.alertDisabled).toBe(true);
	});

	test("blocks when no rule name or no change field", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "alerting-edit" as const, isProd: false, cluster: "eu-b2b", ruleName: "default__x" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("at least one of threshold");
	});

	test("blocks (no create) when the rule file 404s", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__nope",
				alertThreshold: 5,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("not found");
	});

	test("no-op guard: blocks when already at the requested threshold", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__x",
				alertThreshold: 1, // already the current value
			},
		};
		const result = await draftChange(asIacState(state));
		// SIO-1020: a no-op surfaces as noopReason (neutral "No change needed"), not blockedReason.
		expect(result.noopReason).toContain("already has the requested values");
		expect(result.blockedReason).toBeFalsy();
	});
});

describe("reviewPlan — alerting-edit", () => {
	test("config-edit kind, alerting risk line, descriptor in title", async () => {
		const state = {
			iacRequest: {
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__cart_failed",
				alertThreshold: 5,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			alertDisabled: false,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("default__cart_failed");
		expect(result.planReview?.title).toContain("alerting-edit");
		expect(result.risks?.some((r) => r.includes("detection sensitivity"))).toBe(true);
	});

	test("disabling surfaces a leading HIGH risk line", async () => {
		const state = {
			iacRequest: {
				workflow: "alerting-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				ruleName: "default__x",
				alertEnabled: false,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			alertDisabled: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.[0]).toContain("DISABLED");
	});
});
