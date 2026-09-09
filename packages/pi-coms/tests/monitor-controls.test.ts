// tests/monitor-controls.test.ts
import { describe, expect, test } from "bun:test";
import {
	applyControl,
	describeControls,
	envInvestigateDefault,
	investigationDisabledFailure,
	parseControlCommand,
	readControls,
} from "../scripts/monitor/controls.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

describe("parseControlCommand", () => {
	test("investigate on|off with an optional reason", () => {
		expect(parseControlCommand("investigate off")).toEqual({ kind: "investigate", on: false, reason: "" });
		expect(parseControlCommand("Investigate OFF context at 98%")).toEqual({
			kind: "investigate",
			on: false,
			reason: "context at 98%",
		});
		expect(parseControlCommand("investigate on")).toEqual({ kind: "investigate", on: true, reason: "" });
	});

	test("pause and resume", () => {
		expect(parseControlCommand("pause")).toEqual({ kind: "pause", reason: "" });
		expect(parseControlCommand("pause maintenance window")).toEqual({ kind: "pause", reason: "maintenance window" });
		expect(parseControlCommand("resume")).toEqual({ kind: "resume" });
	});

	test("anything else is not a control command", () => {
		expect(parseControlCommand("investigate maybe")).toBeNull();
		expect(parseControlCommand("investigate")).toBeNull();
		expect(parseControlCommand("paused")).toBeNull();
		expect(parseControlCommand("run-checks")).toBeNull();
	});
});

describe("controls persistence", () => {
	test("env default applies only until a control is persisted", () => {
		const s = new MonitorState(":memory:");
		expect(readControls(s, { investigate: false }).investigate).toBe(false);
		const next = applyControl(s, readControls(s, { investigate: false }), {
			kind: "investigate",
			on: true,
			reason: "",
		});
		expect(next.investigate).toBe(true);
		// A later restart with the env still set to off keeps the persisted on.
		expect(readControls(s, { investigate: false }).investigate).toBe(true);
	});

	test("pause and resume round-trip with reason and timestamp", () => {
		const s = new MonitorState(":memory:");
		const now = new Date("2026-09-09T12:00:00.000Z");
		const paused = applyControl(s, readControls(s, { investigate: true }), { kind: "pause", reason: "noise" }, now);
		expect(paused.paused).toBe(true);
		expect(readControls(s, { investigate: true })).toMatchObject({
			paused: true,
			pausedReason: "noise",
			pausedSince: "2026-09-09T12:00:00.000Z",
			investigate: true,
		});
		const resumed = applyControl(s, paused, { kind: "resume" });
		expect(resumed.paused).toBe(false);
		expect(readControls(s, { investigate: true }).paused).toBe(false);
	});

	test("describeControls and the disabled failure reason", () => {
		const s = new MonitorState(":memory:");
		const now = new Date("2026-09-09T12:00:00.000Z");
		const c = applyControl(
			s,
			readControls(s, { investigate: true }),
			{ kind: "investigate", on: false, reason: "context at 98%" },
			now,
		);
		expect(describeControls(c)).toBe("investigate: off (context at 98%, since 2026-09-09T12:00:00.000Z), paused: no");
		expect(investigationDisabledFailure(c)).toBe("investigation disabled by operator: context at 98%");
		expect(describeControls(readControls(s, { investigate: true }))).toContain("investigate: off");
	});
});

test("envInvestigateDefault is a kill switch", () => {
	expect(envInvestigateDefault(undefined)).toBe(true);
	expect(envInvestigateDefault("true")).toBe(true);
	expect(envInvestigateDefault("false")).toBe(false);
	expect(envInvestigateDefault("0")).toBe(false);
});
