// shared/src/pi-diagnoses-adapter.test.ts
// SIO-1830. The fixture is the REAL reply an eu-oit-prd spoke sent on 2026-09-20
// (msg_id 01M2Y0YER09EBRCNV4X1S5QTHH), captured from the hub before it aged out. Account
// ids and trace ids are redacted; the SHAPE is verbatim, which is the whole point: an
// invented fixture would encode the same assumption the reader already got wrong.
import { describe, expect, test } from "bun:test";
import {
	investigationFromDiagnoses,
	PiDiagnosesReplySchema,
	PiInvestigationSchema,
	PiVerdictSchema,
} from "./pi-coms-types.ts";

const LIVE_REPLY = {
	diagnoses: [
		{
			dedup_key: "logs:/ecs/fargate/orders-prd-log-group:6f4e315e1a3f",
			probable_cause:
				"orders-service's ImageEventConsumer.consume() (ImageEventConsumer.java:36) threw java.util.NoSuchElementException: No value present, i.e. an unguarded Optional.get() call failed. 5 distinct events in the 23:25-23:40Z window. This looks like a data-shape issue in the upstream image notification payload rather than an infrastructure fault: the ECS service itself is healthy.",
			affected_resources: [
				"arn:aws:ecs:eu-central-1:REDACTED:service/orders-prd/orders-service",
				"arn:aws:logs:eu-central-1:REDACTED:log-group:/ecs/fargate/orders-prd-log-group",
			],
			suggested_action:
				"Recommend the orders team add a null/absence check around the Optional.get() call at ImageEventConsumer.java:36.",
			evidence: [
				{
					command: "aws logs start-query --log-group-name /ecs/fargate/orders-prd-log-group",
					observation: "5 matching events",
				},
				{
					command: "same query, stack frames",
					observation: "every occurrence bottoms out at ImageEventConsumer.consume",
				},
				{ command: "aws ecs describe-services --cluster orders-prd", observation: "running 2, desired 2, ACTIVE" },
			],
			confidence: 0.75,
		},
	],
};

describe("PiDiagnosesReplySchema (SIO-1830)", () => {
	// The regression itself: this exact payload reached production and was discarded.
	test("accepts the live spoke reply that both existing schemas rejected", () => {
		expect(PiVerdictSchema.safeParse(LIVE_REPLY).success).toBe(false);
		expect(PiInvestigationSchema.safeParse(LIVE_REPLY).success).toBe(false);
		expect(PiDiagnosesReplySchema.safeParse(LIVE_REPLY).success).toBe(true);
	});

	// The adapter must not become a catch-all: a malformed reply still has to fail, or the
	// fail-closed contract is gone.
	test.each([
		["empty object", {}],
		["empty diagnoses", { diagnoses: [] }],
		["diagnosis without probable_cause", { diagnoses: [{ suggested_action: "do a thing" }] }],
		["confidence out of range", { diagnoses: [{ probable_cause: "x", confidence: 1.5 }] }],
		["not an object", "a prose answer"],
	])("still rejects %s", (_label, payload) => {
		expect(PiDiagnosesReplySchema.safeParse(payload).success).toBe(false);
	});
});

describe("investigationFromDiagnoses (SIO-1830)", () => {
	test("produces something PiInvestigationSchema itself accepts", () => {
		const parsed = PiDiagnosesReplySchema.parse(LIVE_REPLY);
		const investigation = investigationFromDiagnoses(parsed);
		// The load-bearing assertion: the adapter's output must satisfy the schema the rest
		// of the pipeline reads, or this just moves the failure downstream.
		expect(PiInvestigationSchema.safeParse(investigation).success).toBe(true);
	});

	test("carries the diagnosis through without losing the operator-relevant parts", () => {
		const investigation = investigationFromDiagnoses(PiDiagnosesReplySchema.parse(LIVE_REPLY));
		expect(investigation.summary).toContain("ImageEventConsumer.java:36");
		expect(investigation.root_cause_hypothesis).toContain("NoSuchElementException");
		expect(investigation.suggested_actions).toHaveLength(1);
		expect(investigation.confidence).toBe(0.75);
		// affected_resources are arns the spoke named; they would be lost if only
		// evidence[] were mapped, so they lead the evidence list.
		expect(investigation.evidence[0]?.resource).toContain("arn:aws:ecs:");
		// evidence[].command becomes resource: the spoke records the COMMAND it ran.
		expect(investigation.evidence.some((e) => e.resource.startsWith("aws logs start-query"))).toBe(true);
		expect(investigation.evidence).toHaveLength(5); // 2 arns + 3 commands
	});

	// An absent confidence must not read as certainty.
	test("defaults a missing confidence to 0.5 rather than assuming the spoke was sure", () => {
		const investigation = investigationFromDiagnoses(
			PiDiagnosesReplySchema.parse({ diagnoses: [{ probable_cause: "something happened" }] }),
		);
		expect(investigation.confidence).toBe(0.5);
		expect(investigation.suggested_actions).toEqual([]);
		expect(investigation.evidence).toEqual([]);
	});
});
