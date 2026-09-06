// agent/src/pi-verdict-memory.test.ts
// SIO-1651: the structured-only rule. A verdict carries spoke-authored free
// text (summary, claims[].evidence, additional_observations,
// recommended_investigation); none of it may reach the durable decision, which
// is rendered into the next turn's prompt.
import { describe, expect, test } from "bun:test";
import type { PiVerdict } from "@devops-agent/shared";
import { buildVerdictDecision, tallyClaims } from "./pi-verdict-memory.ts";

// Every free-text field carries a distinctive marker so a leak is unambiguous.
const verdict: PiVerdict = {
	verdict: "partially_confirmed",
	summary: "LEAKMARKER_SUMMARY the spike is real but the cause differs",
	claims: [
		{ claim: "ALB 5xx spike", status: "confirmed", evidence: "LEAKMARKER_EVIDENCE_A CloudWatch datapoints" },
		{ claim: "target group drained", status: "contradicted", evidence: "LEAKMARKER_EVIDENCE_B targets healthy" },
		{ claim: "deploy correlated", status: "unverifiable", evidence: "LEAKMARKER_EVIDENCE_C no deploy log" },
		{ claim: "retry storm", status: "confirmed", evidence: "LEAKMARKER_EVIDENCE_D client retries" },
	],
	additional_observations: ["LEAKMARKER_OBSERVATION unrelated scaling event"],
	recommended_investigation: "LEAKMARKER_RECOMMENDATION check the client retry policy",
};

const input = {
	estate: "eu-oit-prd",
	target: "eu-oit-prd",
	msgId: "01JMSGID",
	requestId: "thread-42",
	verdict,
};

describe("SIO-1651 tallyClaims", () => {
	test("counts each status", () => {
		expect(tallyClaims(verdict)).toEqual({ confirmed: 2, contradicted: 1, unverifiable: 1 });
	});

	test("a verdict with no claims tallies zeroes", () => {
		expect(tallyClaims({ ...verdict, claims: [] })).toEqual({ confirmed: 0, contradicted: 0, unverifiable: 0 });
	});
});

describe("SIO-1651 buildVerdictDecision", () => {
	test("carries the verdict enum, the claim tally and the ids", () => {
		const decision = buildVerdictDecision(input);
		expect(decision.requestId).toBe("thread-42");
		expect(decision.decision).toBe(
			"pi verify eu-oit-prd: partially_confirmed (claims: 2 confirmed, 1 contradicted, 1 unverifiable) target eu-oit-prd msg 01JMSGID",
		);
	});

	test("no spoke-authored free text reaches the decision line", () => {
		const decision = buildVerdictDecision(input);
		expect(decision.decision).not.toContain("LEAKMARKER");
		// rationale is deliberately absent: it is rendered free text too.
		expect(decision.rationale).toBeUndefined();
	});

	test("no spoke-authored free text reaches the annotations", () => {
		const decision = buildVerdictDecision(input);
		expect(JSON.stringify(decision.annotations)).not.toContain("LEAKMARKER");
	});

	test("annotations are the structured filter keys, all strings", () => {
		const decision = buildVerdictDecision(input);
		expect(decision.annotations).toEqual({
			kind: "pi-verify",
			estate: "eu-oit-prd",
			target: "eu-oit-prd",
			verdict: "partially_confirmed",
			msg_id: "01JMSGID",
			claims_confirmed: "2",
			claims_contradicted: "1",
			claims_unverifiable: "1",
		});
		for (const value of Object.values(decision.annotations ?? {})) expect(typeof value).toBe("string");
	});

	test("no TTL: a verdict is a durable fact", () => {
		expect(buildVerdictDecision(input).ttlSeconds).toBeUndefined();
	});
});
