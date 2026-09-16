// tests/checks-workload-state.test.ts
//
// The SIO-1748 checks, exercised against REAL AWS output captured from
// production (tests/aws-samples.ts) rather than a hand-written client.
//
// The first version of these tests drove a fake ELBv2/ECS/SQS/AutoScaling
// client written from memory. The fake agreed with the code by construction,
// so every assertion passed while all five ECS event patterns matched nothing
// that ECS actually emits. A test that invents the API it is testing against
// proves only that the author was self-consistent.
import { describe, expect, test } from "bun:test";
import { dlqSourcesByArn, parseRedrive } from "../scripts/monitor/checks/queues.ts";
import { signature } from "../scripts/monitor/checks/scaling.ts";
import { partitionTargets } from "../scripts/monitor/checks/targets.ts";
import { classifyServiceEvent } from "../scripts/monitor/checks/tasks.ts";
import {
	ASG_ACTIVITIES_OBSERVED,
	ASG_ACTIVITY_FIELDS_OBSERVED,
	ECS_DOCUMENTED_FAILURE_EVENTS,
	ECS_DOCUMENTED_SELF_HEALING,
	ECS_EVENTS_OBSERVED,
	ELBV2_TARGET_HEALTH_HEALTHY,
	SQS_ATTRIBUTE_NAMES_OBSERVED,
	SQS_REDRIVE_POLICIES_OBSERVED,
} from "./aws-samples.ts";

describe("ECS event classification, against the real event corpus", () => {
	test("the three observed failure events classify", () => {
		const byShape = (needle: string) => ECS_EVENTS_OBSERVED.find((e) => e.message.includes(needle))?.message;

		const failed = byShape("deployment failed: tasks failed to start");
		expect(failed).toBeDefined();
		expect(classifyServiceEvent(failed as string)).toEqual({
			severity: "critical",
			label: "deployment failed to start tasks",
		});

		const rollback = byShape("rolling back to deployment");
		expect(rollback).toBeDefined();
		expect(classifyServiceEvent(rollback as string)).toEqual({ severity: "warn", label: "deployment rolled back" });

		const stuck = byShape("was unable to reach steady state because");
		expect(stuck).toBeDefined();
		expect(classifyServiceEvent(stuck as string)).toEqual({ severity: "warn", label: "cannot reach steady state" });
	});

	// The load-bearing assertion. 2190 real events, and everything that is not
	// one of the three failure shapes must stay silent -- including the events
	// that LOOK like failures.
	test("every other observed event classifies as nothing", () => {
		const FAILURES = [
			"deployment failed: tasks failed to start",
			"rolling back to deployment",
			"was unable to reach steady state because",
		];
		const misfires: { message: string; count: number; got: unknown }[] = [];
		for (const e of ECS_EVENTS_OBSERVED) {
			if (FAILURES.some((f) => e.message.includes(f))) continue;
			const got = classifyServiceEvent(e.message);
			if (got !== null) misfires.push({ message: e.message, count: e.count, got });
		}
		expect(misfires).toEqual([]);
	});

	// 27 real occurrences, and every one self-healed: ECS replaced the tasks and
	// the service returned to steady state. Classifying it here would report a
	// deployment as an incident, and targets.ts already owns persistent
	// unhealthy targets behind a two-cycle gate.
	test("the unhealthy-target events stay silent, because ECS heals them itself", () => {
		const unhealthy = ECS_EVENTS_OBSERVED.filter((e) => e.message.includes("is unhealthy in (target-group"));
		expect(unhealthy.length).toBeGreaterThan(0);
		for (const e of unhealthy) expect(classifyServiceEvent(e.message)).toBeNull();
	});

	// Every documented failure event must classify. The corpus cannot supply
	// these, so AWS's own message list is the source.
	test("every documented ECS failure event classifies, with the expected label", () => {
		for (const { message, label } of ECS_DOCUMENTED_FAILURE_EVENTS) {
			const got = classifyServiceEvent(message);
			expect({ message, label: got?.label ?? null }).toEqual({ message, label });
		}
	});

	// The pattern list went from 3 to 13 when it was rebuilt from the docs.
	// Broader patterns are the obvious way to reintroduce noise, so the corpus
	// regression has to be re-run against the wider list, not just the old one.
	test("widening the list to the documented failures still classifies all routine corpus events as nothing", () => {
		const FAILURES = [
			"deployment failed: tasks failed to start",
			"rolling back to deployment",
			"was unable to reach steady state",
		];
		const misfires = ECS_EVENTS_OBSERVED.filter(
			(e) => !FAILURES.some((f) => e.message.includes(f)) && classifyServiceEvent(e.message) !== null,
		);
		expect(misfires).toEqual([]);
	});

	test("the documented ELB-shaped unhealthy event is excluded too", () => {
		expect(classifyServiceEvent(ECS_DOCUMENTED_SELF_HEALING)).toBeNull();
	});

	test("routine lifecycle chatter stays silent", () => {
		for (const needle of [
			"has reached a steady state",
			"has begun draining connections",
			"registered 2 targets",
			"deployment completed",
			"AZ balanced",
		]) {
			const m = ECS_EVENTS_OBSERVED.find((e) => e.message.includes(needle))?.message;
			expect(m).toBeDefined();
			expect(classifyServiceEvent(m as string)).toBeNull();
		}
	});
});

describe("SQS, against the real attribute set", () => {
	// The real API rejects ApproximateAgeOfOldestMessage with
	// "InvalidAttributeName: Unknown Attribute". The first version of the check
	// requested it on every cycle, which would have thrown every cycle.
	test("ApproximateAgeOfOldestMessage is not a queue attribute", () => {
		expect(SQS_ATTRIBUTE_NAMES_OBSERVED).not.toContain("ApproximateAgeOfOldestMessage");
	});

	test("every attribute the check requests is one the real API returns", () => {
		for (const attr of [
			"QueueArn",
			"ApproximateNumberOfMessages",
			"ApproximateNumberOfMessagesNotVisible",
			"RedrivePolicy",
		]) {
			expect(SQS_ATTRIBUTE_NAMES_OBSERVED).toContain(attr);
		}
	});

	test("real redrive policies parse, with maxReceiveCount as a number", () => {
		for (const raw of SQS_REDRIVE_POLICIES_OBSERVED) {
			const parsed = parseRedrive(raw);
			expect(parsed.arn).toMatch(/^arn:aws:sqs:/);
			expect(parsed.maxReceiveCount).toBe(3);
		}
	});

	test("a DLQ is what something redrives INTO, never what is named -dlq", () => {
		const [policy] = SQS_REDRIVE_POLICIES_OBSERVED;
		const dlqArn = parseRedrive(policy).arn as string;
		const sources = dlqSourcesByArn([
			{
				url: "https://sqs.eu-central-1.amazonaws.com/x/connectors-customer-notifications",
				redriveTo: dlqArn,
				maxReceiveCount: 3,
			},
			// Named like a DLQ, pointed at by nothing.
			{ url: "https://sqs.eu-central-1.amazonaws.com/x/orphan-dlq", redriveTo: null, maxReceiveCount: null },
		]);
		expect(sources.get(dlqArn)?.[0]?.name).toBe("connectors-customer-notifications");
		expect(sources.has("arn:aws:sqs:eu-central-1:000000000000:orphan-dlq")).toBe(false);
	});

	test("a malformed policy classifies nothing rather than inventing a DLQ", () => {
		expect(parseRedrive("{not json").arn).toBeNull();
		expect(parseRedrive(undefined).arn).toBeNull();
	});
});

describe("ELBv2 target partition, against real TargetHealth output", () => {
	// A healthy target's TargetHealth carries State and nothing else: no Reason,
	// no Description. Anything reading them must tolerate absence.
	test("a real healthy target counts as settled and healthy, with no reason field", () => {
		expect(Object.keys(ELBV2_TARGET_HEALTH_HEALTHY.TargetHealth)).toEqual(["State"]);
		const got = partitionTargets([ELBV2_TARGET_HEALTH_HEALTHY]);
		expect(got).toEqual({ settled: 1, healthy: 1, unhealthy: [] });
	});

	// draining and initial are what a rolling deployment looks like, so they are
	// not settled state and must not count either way.
	test("draining and initial targets are excluded from the partition entirely", () => {
		const base = ELBV2_TARGET_HEALTH_HEALTHY;
		const got = partitionTargets([
			{ ...base, TargetHealth: { State: "draining" } },
			{ ...base, TargetHealth: { State: "initial" } },
			base,
		]);
		expect(got.settled).toBe(1);
		expect(got.healthy).toBe(1);
		expect(got.unhealthy).toEqual([]);
	});

	test("an unhealthy target is captured with its reason when one is present", () => {
		const got = partitionTargets([
			{
				Target: { Id: "10.0.1.99", Port: 8080 },
				TargetHealth: { State: "unhealthy", Reason: "Target.FailedHealthChecks", Description: "Health checks failed" },
			},
		]);
		expect(got).toEqual({
			settled: 1,
			healthy: 0,
			unhealthy: [
				{ id: "10.0.1.99", port: 8080, reason: "Target.FailedHealthChecks", description: "Health checks failed" },
			],
		});
	});

	// unavailable means health checks are disabled: the target is not failing,
	// so it must not be reported as unhealthy.
	test("unavailable is settled but neither healthy nor unhealthy", () => {
		const got = partitionTargets([{ Target: { Id: "i-1" }, TargetHealth: { State: "unavailable" } }]);
		expect(got).toEqual({ settled: 1, healthy: 0, unhealthy: [] });
	});
});

describe("Auto Scaling, against real activity output", () => {
	// StatusMessage is absent on a successful activity, so the summary must fall
	// back to Description or Cause rather than assume it.
	test("a real successful activity carries no StatusMessage", () => {
		expect(ASG_ACTIVITY_FIELDS_OBSERVED).not.toContain("StatusMessage");
		for (const a of ASG_ACTIVITIES_OBSERVED) expect(a).not.toHaveProperty("StatusMessage");
	});

	// One cause takes many activities. These three real Causes differ only in
	// timestamps, instance ids and counts, so they must collapse to one.
	test("real causes differing only in ids, times and counts share a signature", () => {
		const sigs = new Set(ASG_ACTIVITIES_OBSERVED.map((a) => signature(a.Cause)));
		expect(sigs.size).toBeLessThan(ASG_ACTIVITIES_OBSERVED.length);
	});

	test("real instance-termination descriptions collapse to one signature", () => {
		const sigs = new Set(ASG_ACTIVITIES_OBSERVED.map((a) => signature(a.Description)));
		expect(sigs.size).toBe(1);
		expect([...sigs][0]).toContain("<instance>");
	});

	test("genuinely different causes keep different signatures", () => {
		expect(signature("Could not launch On-Demand Instances. InsufficientInstanceCapacity")).not.toBe(
			signature("The security group sg-123 does not exist"),
		);
	});
});
