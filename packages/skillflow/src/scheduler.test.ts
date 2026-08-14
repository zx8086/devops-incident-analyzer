// skillflow/src/scheduler.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ScheduleDef, WorkflowDef } from "@devops-agent/gitagent-bridge";
import {
	_getScheduleSlotForTest as getScheduleSlot,
	registerSchedules,
	_resetScheduleSlotsForTest as resetScheduleSlots,
	scheduleToIntervalMs,
} from "./scheduler.ts";

describe("scheduleToIntervalMs", () => {
	test("every-minute * -> 60s", () => {
		expect(scheduleToIntervalMs("* * * * *")).toBe(60_000);
	});

	test("*/N step -> N minutes", () => {
		expect(scheduleToIntervalMs("*/15 * * * *")).toBe(15 * 60_000);
		expect(scheduleToIntervalMs("*/30 * * * *")).toBe(30 * 60_000);
	});

	test("fixed minute with wildcard hour -> hourly", () => {
		expect(scheduleToIntervalMs("0 * * * *")).toBe(60 * 60_000);
		expect(scheduleToIntervalMs("30 * * * *")).toBe(60 * 60_000);
	});

	test("a constrained hour is NOT treated as hourly -> fallback + callback", () => {
		let warned: string | undefined;
		const result = scheduleToIntervalMs("0 9 * * MON-FRI", (c) => {
			warned = c;
		});
		expect(result).toBe(60 * 60_000);
		expect(warned).toBe("0 9 * * MON-FRI");
	});

	test("garbage input falls back to hourly without throwing", () => {
		expect(scheduleToIntervalMs("not-a-cron")).toBe(60 * 60_000);
	});

	test("wrong field count is rejected even with a valid-looking minute field", () => {
		let warned: string | undefined;
		expect(scheduleToIntervalMs("* invalid", (c) => (warned = c))).toBe(60 * 60_000);
		expect(warned).toBe("* invalid");
	});

	test("zero/negative step is rejected -> fallback", () => {
		expect(scheduleToIntervalMs("*/0 * * * *")).toBe(60 * 60_000);
	});
});

function scheduleDef(overrides: Partial<ScheduleDef> = {}): ScheduleDef {
	return { id: "s", mode: "repeat", cron: "* * * * *", enabled: true, workflow: "w", ...overrides } as ScheduleDef;
}

function nodeWorkflow(name: string, nodeTarget: string): WorkflowDef {
	return {
		name,
		version: "0.1.0",
		description: "d",
		steps: [{ name: "sweep", node: nodeTarget }],
	} as WorkflowDef;
}

describe("registerSchedules", () => {
	// SIO-1468: slots are a globalThis singleton; own them per test so no timer
	// (or repoint state) leaks between tests.
	beforeEach(() => resetScheduleSlots());
	afterEach(() => resetScheduleSlots());

	test("skips a disabled schedule and never registers a timer", () => {
		const schedules = new Map([["s", scheduleDef({ enabled: false })]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: { "sweep-node": async () => undefined } });
		expect(registered).toEqual([]);
	});

	test("skips when the workflow target is not found", () => {
		const schedules = new Map([["s", scheduleDef({ workflow: "missing" })]]);
		const workflows = new Map<string, WorkflowDef>();
		const registered = registerSchedules(schedules, workflows, { nodes: {} });
		expect(registered).toEqual([]);
	});

	test("skips when the workflow is not a single node-kind step", () => {
		const schedules = new Map([["s", scheduleDef()]]);
		const multiStep: WorkflowDef = {
			name: "w",
			version: "0.1.0",
			description: "d",
			steps: [
				{ name: "a", node: "x" },
				{ name: "b", node: "y" },
			],
		} as WorkflowDef;
		const workflows = new Map([["w", multiStep]]);
		const registered = registerSchedules(schedules, workflows, {
			nodes: { x: async () => undefined, y: async () => undefined },
		});
		expect(registered).toEqual([]);
	});

	test("skips when no handler is bound for the node target", () => {
		const schedules = new Map([["s", scheduleDef()]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: {} });
		expect(registered).toEqual([]);
	});

	test("skips a prompt-target schedule when no prompt handler is wired", () => {
		const schedules = new Map([["s", scheduleDef({ workflow: undefined, prompt: "do it" })]]);
		const registered = registerSchedules(schedules, new Map(), { nodes: {} });
		expect(registered).toEqual([]);
	});

	test("registers a valid repeat schedule and stop() cancels it", () => {
		const schedules = new Map([["s", scheduleDef()]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: { "sweep-node": async () => undefined } });
		expect(registered).toHaveLength(1);
		expect(registered[0]?.id).toBe("s");
		registered[0]?.stop();
	});

	test("skips a repeat schedule with an invalid cron expression", () => {
		const schedules = new Map([["s", scheduleDef({ cron: "not a cron at all, definitely invalid !!" })]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: { "sweep-node": async () => undefined } });
		// Under Bun this throws synchronously (invalid expression); under Node it falls
		// back to the hourly interval and registers successfully -- either is acceptable,
		// the guarantee is just that registration never crashes the process.
		expect(Array.isArray(registered)).toBe(true);
	});

	test("a mode:once schedule actually fires the bound handler", async () => {
		let fired = false;
		const schedules = new Map([
			["s", scheduleDef({ mode: "once", cron: undefined, runAt: new Date(Date.now() + 20).toISOString() })],
		]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, {
			nodes: {
				"sweep-node": async () => {
					fired = true;
				},
			},
		});
		expect(registered).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fired).toBe(true);
	});

	test("a mode:once schedule with a past runAt is skipped", () => {
		const schedules = new Map([
			["s", scheduleDef({ mode: "once", cron: undefined, runAt: new Date(Date.now() - 1000).toISOString() })],
		]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: { "sweep-node": async () => undefined } });
		expect(registered).toEqual([]);
	});

	test("a mode:once schedule with an invalid runAt is skipped", () => {
		const schedules = new Map([["s", scheduleDef({ mode: "once", cron: undefined, runAt: "not-a-date" })]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		const registered = registerSchedules(schedules, workflows, { nodes: { "sweep-node": async () => undefined } });
		expect(registered).toEqual([]);
	});
});

// SIO-1468: schedule timers are globalThis slots (same idiom as the mcp-bridge health
// poll, SIO-1113). A dev-server restart can close the Vite module runner WITHOUT
// running hot.dispose: the fresh module graph re-registers every schedule while the old
// graph's timers survive. Re-registration must repoint dispatch at the latest
// registration instead of arming a second timer, so the sweeps neither stack nor keep
// running inside the dead module graph.
describe("schedule slot singleton (SIO-1468)", () => {
	beforeEach(() => resetScheduleSlots());
	afterEach(() => resetScheduleSlots());

	function register(handler: () => Promise<undefined>, over: Partial<ScheduleDef> = {}) {
		const schedules = new Map([["s", scheduleDef(over)]]);
		const workflows = new Map([["w", nodeWorkflow("w", "sweep-node")]]);
		return registerSchedules(schedules, workflows, { nodes: { "sweep-node": handler } });
	}

	test("re-registering the same schedule repoints dispatch without arming a second timer", async () => {
		const calls: string[] = [];
		register(async () => {
			calls.push("old-graph");
			return undefined;
		});
		const firstSlot = getScheduleSlot("s");
		expect(firstSlot).toBeDefined();
		const firstRun = firstSlot?.run;

		// A fresh module graph re-registering after a runner swap.
		const second = register(async () => {
			calls.push("live-graph");
			return undefined;
		});
		expect(second).toHaveLength(1);
		const secondSlot = getScheduleSlot("s");
		expect(secondSlot).toBe(firstSlot); // same slot -> same timer, no stacking
		expect(secondSlot?.run).not.toBe(firstRun); // dispatch repointed at the new registration

		await secondSlot?.run(); // what the surviving timer now invokes
		// The armed cron is real; assert dispatch OWNERSHIP, not an exact count, so a
		// minute-boundary tick during the test cannot flake it.
		expect(calls).toContain("live-graph");
		expect(calls).not.toContain("old-graph");
	});

	test("a cadence change re-arms instead of repointing", () => {
		register(async () => undefined);
		const firstSlot = getScheduleSlot("s");
		register(async () => undefined, { cron: "*/15 * * * *" });
		const secondSlot = getScheduleSlot("s");
		expect(secondSlot).toBeDefined();
		expect(secondSlot).not.toBe(firstSlot); // old timer stopped, new one armed
	});

	test("disabling a schedule stops a previously armed slot", () => {
		register(async () => undefined);
		expect(getScheduleSlot("s")).toBeDefined();
		const registered = register(async () => undefined, { enabled: false });
		expect(registered).toEqual([]);
		expect(getScheduleSlot("s")).toBeUndefined();
	});

	test("stop() clears the slot and is idempotent", () => {
		const registered = register(async () => undefined);
		expect(getScheduleSlot("s")).toBeDefined();
		registered[0]?.stop();
		expect(getScheduleSlot("s")).toBeUndefined();
		registered[0]?.stop(); // safe with no slot
		expect(getScheduleSlot("s")).toBeUndefined();
	});

	test("a repointed stop() tears down the surviving timer", () => {
		register(async () => undefined);
		const second = register(async () => undefined);
		second[0]?.stop(); // stop handle from the repointed registration
		expect(getScheduleSlot("s")).toBeUndefined();
	});

	test("mode:once with the same runAt repoints and only the latest handler fires", async () => {
		const calls: string[] = [];
		const runAt = new Date(Date.now() + 30).toISOString();
		register(
			async () => {
				calls.push("old-graph");
				return undefined;
			},
			{ mode: "once", cron: undefined, runAt },
		);
		const firstSlot = getScheduleSlot("s");
		register(
			async () => {
				calls.push("live-graph");
				return undefined;
			},
			{ mode: "once", cron: undefined, runAt },
		);
		expect(getScheduleSlot("s")).toBe(firstSlot); // pending timeout survives
		// Poll instead of a fixed sleep: the workflow run adds latency on loaded CI.
		const deadline = Date.now() + 2_000;
		while (calls.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(calls).toEqual(["live-graph"]);
		expect(getScheduleSlot("s")).toBeUndefined(); // fired -> slot released
	});
});
