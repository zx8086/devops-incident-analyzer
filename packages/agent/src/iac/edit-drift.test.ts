// agent/src/iac/edit-drift.test.ts
// SIO-1310: per-request scoped stack drift-check (the maker lane's live-parity gate).
import { describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { IacRequest, IacStateType, StackDrift } from "./state.ts";

// Mocks must be installed BEFORE nodes.ts is imported (live-binding poisoning otherwise);
// every test dynamic-imports nodes.ts after arming its own mocks, mirroring
// pipeline-watch-parity.test.ts.
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>): { calls: string[] } {
	const sink = { calls: [] as string[] };
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => {
			sink.calls.push(name);
			return fn(args);
		},
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
	return sink;
}

function silenceProgress(): void {
	mock.module("@langchain/core/callbacks/dispatch", () => ({
		dispatchCustomEvent: async () => {},
	}));
}

// A drift-report body with one actionable update (the SLO objective changed live).
const DRIFTED_REPORT = JSON.stringify({
	has_actionable_drift: true,
	totals: { create: 0, update: 1, destroy: 0, replace: 0, noop: 0, "known-noise": 0 },
	resources: [
		{
			address: 'module.slos["payments"].elasticstack_kibana_slo.this',
			actions: ["update"],
			category: "update",
			reason: "attributes changed: objective",
			changedKeys: ["objective"],
			values: { objective: { before: 0.99, after: 0.995 } },
		},
	],
});

const CLEAN_REPORT = JSON.stringify({
	has_actionable_drift: false,
	totals: { create: 0, update: 0, destroy: 0, replace: 0, noop: 3, "known-noise": 0 },
	resources: [],
});

const TRIGGER_OK = JSON.stringify({ stack: "slos", deployment: "eu-b2b", pipelineId: 42, status: "created" });
const TRIGGER_LOCKED = JSON.stringify({ pipelineId: null, status: "locked", note: "apply in progress" });

function successResult(report: string): string {
	return JSON.stringify({ status: "success", report });
}

const REQ = { workflow: "slo-edit", cluster: "eu-b2b" } as IacRequest;

async function withEditDriftEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.ELASTIC_IAC_EDIT_DRIFT_CHECK;
	if (value === undefined) delete process.env.ELASTIC_IAC_EDIT_DRIFT_CHECK;
	else process.env.ELASTIC_IAC_EDIT_DRIFT_CHECK = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.ELASTIC_IAC_EDIT_DRIFT_CHECK;
		else process.env.ELASTIC_IAC_EDIT_DRIFT_CHECK = prev;
	}
}

describe("editDriftCheckEnabled (SIO-1310 kill-switch)", () => {
	test("defaults ON, and only the literal false disables", async () => {
		silenceProgress();
		mockTools({});
		const { editDriftCheckEnabled } = await import("./nodes.ts");
		await withEditDriftEnv(undefined, async () => expect(editDriftCheckEnabled()).toBe(true));
		await withEditDriftEnv("true", async () => expect(editDriftCheckEnabled()).toBe(true));
		await withEditDriftEnv("false", async () => expect(editDriftCheckEnabled()).toBe(false));
		await withEditDriftEnv(" FALSE ", async () => expect(editDriftCheckEnabled()).toBe(false));
	});
});

describe("no-op message helpers (SIO-1310)", () => {
	test("upgradeNoopMessagesVerified replaces the repo-only caveat with the verified line", async () => {
		silenceProgress();
		mockTools({});
		const { repoOnlyCaveat, upgradeNoopMessagesVerified } = await import("./nodes.ts");
		const noop = new AIMessage(`No change needed: already as requested.${repoOnlyCaveat("eu-b2b")}`);
		const out = upgradeNoopMessagesVerified([noop], "eu-b2b", "slos");
		const text = String(out[0]?.content);
		expect(text).not.toContain("I did not verify the live cluster");
		expect(text).toContain("Verified against the LIVE deployment too");
		expect(text).toContain("'slos' stack drift-check reports no drift");
	});

	test("upgradeNoopMessagesVerified appends when the caveat is absent", async () => {
		silenceProgress();
		mockTools({});
		const { upgradeNoopMessagesVerified } = await import("./nodes.ts");
		const out = upgradeNoopMessagesVerified([new AIMessage("No change needed.")], "eu-b2b", "slos");
		expect(String(out[0]?.content)).toContain("Verified against the LIVE deployment too");
	});

	test("appendNoopPlanErrorNote keeps the caveat and adds the not-authoritative note", async () => {
		silenceProgress();
		mockTools({});
		const { appendNoopPlanErrorNote, repoOnlyCaveat } = await import("./nodes.ts");
		const noop = new AIMessage(`No change needed.${repoOnlyCaveat("eu-b2b")}`);
		const out = appendNoopPlanErrorNote([noop], "slos", "Apply in progress (state lock); re-check once it clears.");
		const text = String(out[0]?.content);
		expect(text).toContain("I did not verify the live cluster");
		expect(text).toContain("was attempted but was not authoritative");
		expect(text).toContain("state lock");
	});
});

describe("buildStackDriftAdvisory (SIO-1310)", () => {
	test("names the stack, counts, and resources; never says the reviewPlan HIGH-risk phrase", async () => {
		silenceProgress();
		mockTools({});
		const { buildStackDriftAdvisory } = await import("./nodes.ts");
		const drift: StackDrift = {
			stack: "slos",
			drifted: true,
			kind: "config-json",
			create: 0,
			update: 2,
			delete: 1,
			liveReconcilable: true,
			resources: [
				{ address: 'module.slos["a"].elasticstack_kibana_slo.this', actions: ["update"], changedKeys: ["objective"] },
				{ address: 'module.slos["b"].elasticstack_kibana_slo.this', actions: ["update"] },
				{ address: 'module.slos["c"].elasticstack_kibana_slo.this', actions: ["delete"] },
				{ address: 'module.slos["d"].elasticstack_kibana_slo.this', actions: ["update"] },
			],
		};
		const advisory = buildStackDriftAdvisory(drift, "eu-b2b");
		expect(advisory).toContain("Pre-existing live drift in the 'slos' stack");
		expect(advisory).toContain("0 create / 2 update / 1 destroy");
		expect(advisory).toContain("objective");
		expect(advisory).toContain("and 1 more resource(s)");
		expect(advisory).toContain("check eu-b2b for drift");
		// SIO-983 promotes this exact phrase to a HIGH risk in reviewPlan -- the advisory must avoid it.
		expect(advisory).not.toContain("not in live");
	});

	test("returns empty for a clean stack", async () => {
		silenceProgress();
		mockTools({});
		const { buildStackDriftAdvisory } = await import("./nodes.ts");
		const clean = {
			stack: "slos",
			drifted: false,
			kind: "config-json",
			create: 0,
			update: 0,
			delete: 0,
			liveReconcilable: false,
			resources: [],
		} as StackDrift;
		expect(buildStackDriftAdvisory(clean, "eu-b2b")).toBe("");
	});
});

describe("applyEditDriftCheck (SIO-1310)", () => {
	test("kill-switch OFF: result passes through untouched and NO tool is called", async () => {
		silenceProgress();
		const sink = mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(DRIFTED_REPORT),
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const result = { noopReason: "already set", messages: [new AIMessage("No change needed.")] };
		await withEditDriftEnv("false", async () => {
			const out = await applyEditDriftCheck(REQ, result);
			expect(out).toBe(result);
			expect(sink.calls).toEqual([]);
		});
	});

	test("version-upgrade is excluded (its own SIO-1196 three-way check; no double pipeline)", async () => {
		silenceProgress();
		const sink = mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(DRIFTED_REPORT),
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const req = { workflow: "version-upgrade", cluster: "eu-b2b" } as IacRequest;
		const result = { noopReason: "already at target", messages: [new AIMessage("No change needed.")] };
		const out = await applyEditDriftCheck(req, result);
		expect(out).toBe(result);
		expect(sink.calls).toEqual([]);
	});

	test("blocked results pass through untouched", async () => {
		silenceProgress();
		const sink = mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(DRIFTED_REPORT),
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const result = { blockedReason: "guard says no", messages: [new AIMessage("Blocked.")] };
		const out = await applyEditDriftCheck(REQ, result);
		expect(out).toBe(result);
		expect(sink.calls).toEqual([]);
	});

	test("no-op + clean live check: verdict upgrades to verified live parity", async () => {
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(CLEAN_REPORT),
		});
		const { applyEditDriftCheck, repoOnlyCaveat } = await import("./nodes.ts");
		const result = {
			noopReason: "already set",
			messages: [new AIMessage(`No change needed: SLO already as requested.${repoOnlyCaveat("eu-b2b")}`)],
		};
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.noopReason).toBe("already set");
		const text = String((out.messages?.[0] as AIMessage | undefined)?.content);
		expect(text).toContain("Verified against the LIVE deployment too");
		expect(text).not.toContain("I did not verify the live cluster");
	});

	test("no-op + live drift: seeds editDrift + one-stack driftReport with liveReconcilable false", async () => {
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(DRIFTED_REPORT),
		});
		const { applyEditDriftCheck, repoOnlyCaveat } = await import("./nodes.ts");
		const result = {
			noopReason: "already set",
			messages: [new AIMessage(`No change needed.${repoOnlyCaveat("eu-b2b")}`)],
		};
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.intent).toBe("drift");
		expect(out.editDrift).toEqual({ deployment: "eu-b2b", stack: "slos", workflow: "slo-edit" });
		expect(out.targetDeployment).toBe("eu-b2b");
		expect(out.driftReport?.stacks).toHaveLength(1);
		expect(out.driftReport?.stacks[0]?.stack).toBe("slos");
		expect(out.driftReport?.stacks[0]?.drifted).toBe(true);
		// Direction safety: reconcile-to-live would overwrite the just-asserted values.
		expect(out.driftReport?.stacks[0]?.liveReconcilable).toBe(false);
		expect(out.driftIndex).toBe(0);
		// The false no-op verdict is dropped so routeAfterDraft reaches the drift lane.
		expect(out.noopReason).toBeUndefined();
		const text = String((out.messages?.[0] as AIMessage | undefined)?.content);
		expect(text).toContain("drift-reconcile");
		expect(text).toContain("deliberately not offered");
	});

	test("no-op + trigger lock (planError): caveat stays, not-authoritative note appended", async () => {
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_LOCKED,
		});
		const { applyEditDriftCheck, repoOnlyCaveat } = await import("./nodes.ts");
		const result = {
			noopReason: "already set",
			messages: [new AIMessage(`No change needed.${repoOnlyCaveat("eu-b2b")}`)],
		};
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.noopReason).toBe("already set");
		expect(out.editDrift).toBeUndefined();
		const text = String((out.messages?.[0] as AIMessage | undefined)?.content);
		expect(text).toContain("I did not verify the live cluster");
		expect(text).toContain("was attempted but was not authoritative");
	});

	test("drafted change + live drift: attaches the review-card advisory, result otherwise intact", async () => {
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(DRIFTED_REPORT),
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const result = { branch: "agent/slo-payments-20260731", precheckPassed: true, proposedFiles: ["x.json"] };
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.branch).toBe("agent/slo-payments-20260731");
		expect(out.stackDriftAdvisory).toContain("Pre-existing live drift in the 'slos' stack");
		expect(out.editDrift).toBeUndefined();
	});

	test("drafted change + clean stack: no advisory", async () => {
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => TRIGGER_OK,
			gitlab_get_drift_check_result: () => successResult(CLEAN_REPORT),
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const result = { branch: "agent/slo-payments-20260731" };
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.stackDriftAdvisory).toBeUndefined();
	});

	test("a failing tool call degrades to the not-authoritative note (never breaks the turn)", async () => {
		// callTool catches tool errors and returns a placeholder string, so a network-down check
		// flows through driftCheckStack's planError path -- the no-op verdict survives with a note.
		silenceProgress();
		mockTools({
			gitlab_trigger_drift_check: () => {
				throw new Error("network down");
			},
		});
		const { applyEditDriftCheck } = await import("./nodes.ts");
		const result = { noopReason: "already set", messages: [new AIMessage("No change needed.")] };
		const out = await applyEditDriftCheck(REQ, result);
		expect(out.noopReason).toBe("already set");
		expect(out.editDrift).toBeUndefined();
		expect(String((out.messages?.[0] as AIMessage | undefined)?.content)).toContain(
			"was attempted but was not authoritative",
		);
	});
});

describe("routeAfterDraft with editDrift (SIO-1310)", () => {
	test("editDrift routes to explainDrift; noopReason still wins END; default is reviewPlan", async () => {
		silenceProgress();
		mockTools({});
		const { routeAfterDraft } = await import("./graph.ts");
		const base = { blockedReason: "", noopReason: "", versionDrift: null, editDrift: null } as IacStateType;
		expect(routeAfterDraft({ ...base, editDrift: { deployment: "d", stack: "s", workflow: "w" } })).toBe(
			"explainDrift",
		);
		expect(routeAfterDraft({ ...base, noopReason: "noop" })).toBe("__end__");
		expect(routeAfterDraft(base)).toBe("reviewPlan");
	});
});
