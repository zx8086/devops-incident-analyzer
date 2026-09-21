// tests/monitor-actionability-judge.test.ts
// SIO-1838. The ask function is injected; every response body below is the shape
// a real jev-1.13.0 call returned on 2026-09-20 (`{type:"noul", noul}` plus
// usage), captured before this file was written rather than taken from the docs.
import { describe, expect, test } from "bun:test";
import {
	isActionabilityEnforcing,
	isActionabilityGateEnabled,
	judgeActionability,
	redactMonitorText,
} from "../scripts/monitor/actionability-judge.ts";
import type { Finding } from "../scripts/monitor/report.ts";
import type { askSystemOne, SystemOneResponse } from "../scripts/monitor/typesafe.ts";

type Ask = typeof askSystemOne;

function finding(key: string): Finding {
	return {
		family: "tasks",
		severity: "warn",
		resource: `ecs:prod/${key}`,
		summary: `${key} drained connections`,
		dedup_key: key,
		evidence: {},
		at: "2026-09-20T10:00:00.000Z",
	};
}

function reply(routine: number, duplicate?: number): SystemOneResponse {
	const answers: SystemOneResponse["answers"] = { routine: { type: "noul", noul: routine } };
	if (duplicate !== undefined) answers.duplicate = { type: "noul", noul: duplicate };
	return { model: "jev-1.13.0", answers, usage: { input_tokens: 396, output_tokens: 36 } };
}

describe("actionability flags", () => {
	test("the gate defaults ON, kill-switch only", () => {
		expect(isActionabilityGateEnabled({})).toBe(true);
		expect(isActionabilityGateEnabled({ MONITOR_ACTIONABILITY_ENABLED: "false" })).toBe(false);
		expect(isActionabilityGateEnabled({ MONITOR_ACTIONABILITY_ENABLED: "0" })).toBe(false);
	});

	test("enforcement also defaults ON, with its own kill-switch", () => {
		// A gate that only observes never does its job. Safety comes from the shape
		// of the decision (critical never gated, p >= 0.85 to skip, missing verdict
		// sends, errors send) rather than from declining to act.
		expect(isActionabilityEnforcing({})).toBe(true);
		expect(isActionabilityEnforcing({ MONITOR_ACTIONABILITY_ENFORCING: "false" })).toBe(false);
		expect(isActionabilityEnforcing({ MONITOR_ACTIONABILITY_ENFORCING: "0" })).toBe(false);
	});
});

describe("judgeActionability", () => {
	test("maps verdicts back by dedup_key", async () => {
		const ask = (async (o: Parameters<Ask>[0]) => {
			const f = (o.state as { finding: { dedup_key?: string; summary: string } }).finding;
			return reply(f.summary.startsWith("a") ? 0.95 : 0.1, 0.2);
		}) as Ask;
		const out = await judgeActionability([finding("a"), finding("b")], ["something else"], { apiKey: "k", ask });
		expect(out.get("a")?.routine).toBeCloseTo(0.95, 6);
		expect(out.get("b")?.routine).toBeCloseTo(0.1, 6);
	});

	test("one failed request voids the whole round", async () => {
		// Greptile PR #871. Returning the verdicts that DID succeed let the caller
		// enforce them while the classifier was visibly degraded -- a gate that can
		// hold back a real incident must not run on partial information. Throwing
		// puts the caller on its error path, which investigates everything.
		let n = 0;
		const ask = (async () => {
			n += 1;
			if (n === 1) throw new Error("boom");
			return reply(0.9, 0.1);
		}) as Ask;
		await expect(judgeActionability([finding("a"), finding("b")], [], { apiKey: "k", ask })).rejects.toThrow(
			/1\/2 requests failed/,
		);
	});

	test("a reply missing the routine answer yields NO verdict, not a zero", async () => {
		// Defaulting it would mean "definitely not routine", which is a judgement
		// the model did not make.
		const ask = (async () => ({ model: "jev-1.13.0", answers: {} }) as SystemOneResponse) as Ask;
		const out = await judgeActionability([finding("a")], [], { apiKey: "k", ask });
		expect(out.size).toBe(0);
	});

	test("the duplicate question is omitted when there is nothing to compare against", async () => {
		// Asking it against an empty list invites an answer with nothing behind it.
		let asked: string[] = [];
		const ask = (async (o: Parameters<Ask>[0]) => {
			asked = Object.keys(o.questions);
			return reply(0.3);
		}) as Ask;
		await judgeActionability([finding("a")], [], { apiKey: "k", ask });
		expect(asked).toEqual(["routine"]);

		await judgeActionability([finding("a")], ["a prior diagnosis"], { apiKey: "k", ask });
		expect(asked).toEqual(["routine", "duplicate"]);
	});

	test("a missing duplicate answer is 0, which sends", async () => {
		const ask = (async () => reply(0.2)) as Ask;
		const out = await judgeActionability([finding("a")], ["prior"], { apiKey: "k", ask });
		expect(out.get("a")?.duplicate).toBe(0);
	});

	test("recent context is capped, so the state cannot grow without bound", async () => {
		let sent: string[] = [];
		const ask = (async (o: Parameters<Ask>[0]) => {
			sent = (o.state as { recent_diagnosed?: string[] }).recent_diagnosed ?? [];
			return reply(0.1, 0.1);
		}) as Ask;
		const many = Array.from({ length: 40 }, (_, i) => `prior ${i}`);
		await judgeActionability([finding("a")], many, { apiKey: "k", ask });
		expect(sent).toHaveLength(8);
	});

	test("sends only the finding fields the questions name", async () => {
		// Evidence blobs and timestamps are not part of either judgement, and
		// unrelated material measurably costs accuracy.
		let state: Record<string, unknown> = {};
		const ask = (async (o: Parameters<Ask>[0]) => {
			state = o.state as Record<string, unknown>;
			return reply(0.1);
		}) as Ask;
		await judgeActionability([finding("a")], [], { apiKey: "k", ask });
		expect(Object.keys(state.finding as object).sort()).toEqual(["family", "resource", "severity", "summary"]);
	});

	test("redacts secrets and identifiers before anything leaves the account", async () => {
		// Greptile PR #871: a monitor summary can carry a raw log excerpt, an RDS
		// event message, an ARN or an IAM principal, and this is the first thing in
		// pi-coms to send any of it off-box.
		let state: { finding: { resource: string; summary: string }; recent_diagnosed?: string[] } = {
			finding: { resource: "", summary: "" },
		};
		const ask = (async (o: Parameters<Ask>[0]) => {
			state = o.state as typeof state;
			return reply(0.1, 0.1);
		}) as Ask;
		const f = finding("a");
		f.resource = "arn:aws:lambda:eu-west-1:123456789012:function:payments-api";
		f.summary = "error for alice@example.com in account 123456789012 using AKIAIOSFODNN7EXAMPLE";

		await judgeActionability([f], ["arn:aws:s3:::secret-bucket/key: prior"], { apiKey: "k", ask });

		expect(state.finding.resource).toBe("[ARN_REDACTED]");
		expect(state.finding.summary).not.toContain("alice@example.com");
		expect(state.finding.summary).not.toContain("123456789012");
		expect(state.finding.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(state.recent_diagnosed?.[0]).not.toContain("secret-bucket");
	});

	test("leaves IPv4 alone, matching the shared redactor", () => {
		// SIO-861: internal infrastructure, and the address is often the subject.
		expect(redactMonitorText("host 10.2.3.4 refused")).toBe("host 10.2.3.4 refused");
	});

	test("an empty batch makes no requests", async () => {
		let calls = 0;
		const ask = (async () => {
			calls += 1;
			return reply(0.5);
		}) as Ask;
		const out = await judgeActionability([], ["prior"], { apiKey: "k", ask });
		expect(out.size).toBe(0);
		expect(calls).toBe(0);
	});
});
