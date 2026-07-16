// agent/src/learn/distill.test.ts

import { describe, expect, test } from "bun:test";
import { buildDistillerMessages, parseLearningProposal } from "./distill.ts";
import type { TicketResolution } from "./ticket.ts";

function ticket(overrides: Partial<TicketResolution> = {}): TicketResolution {
	return {
		key: "DEVOPS-1355",
		summary: "Kafka controller election storm",
		status: "In Progress",
		description: "Agent report: SASL credential failure suspected. Contact oncall@example.test.",
		comments: [
			{
				author: "Ops Engineer",
				createdAt: "2026-07-16T12:44:22Z",
				body: "Root cause found: it's a DNS/network gap, not credentials. Resolver associations are per-VPC and not transitive over the TGW.",
			},
		],
		...overrides,
	};
}

// A canned distiller response shaped like the DEVOPS-1355 correction.
const CANNED_RESPONSE = JSON.stringify({
	ticketKey: "DEVOPS-1355",
	rootCause: {
		id: "rc-1",
		kind: "root-cause",
		causeClass: "route53-resolver-rule-vpc-association-missing",
		description:
			"The workload VPC has no Confluent Route53 resolver rule associated, so the broker hostname resolves to non-routable IPs and the TCP timeout mimics an auth failure.",
		resolution:
			"Associate resolver rule rslvr-rr-0example000000001 with vpc-0example1234567890a via the infrastructure repo.",
		invalidatedHypotheses: [
			{
				hypothesis: "Confluent API key or secret invalid in SSM",
				reason: "The client never connects; the credential is untestable until the network path is open.",
			},
		],
		evidence: ["Root cause found: it's a DNS/network gap, not credentials."],
	},
	bindings: [],
	heuristics: [],
	memoryFacts: [
		{
			id: "fact-1",
			kind: "memory-fact",
			text: "Route53 resolver rule associations are per-VPC and NOT transitive over the Transit Gateway.",
			evidence: ["Resolver associations are per-VPC and not transitive over the TGW."],
		},
	],
});

describe("SIO-1126 buildDistillerMessages", () => {
	// NOTE: PII stripping delegates to @devops-agent/shared's redactPiiContent,
	// proven in packages/shared's pii-redactor tests. We intentionally do NOT
	// assert email absence here: aggregator.test.ts stubs that function to an
	// identity passthrough process-globally, so such an assertion is load-order
	// flaky (the skill-learner redactForJudge precedent). We assert structure.
	test("includes ticket, matched-incident context, and the runbook catalog", () => {
		const messages = buildDistillerMessages({
			ticket: ticket(),
			incidentSummary: "prior investigation of example-consumer-service",
			existingRootCause: {
				id: "abc",
				class: "kafka-significant-lag",
				description: "machine-derived",
				confidence: 0.8,
				ruleName: "kafka-significant-lag",
			},
			runbookCatalog: [{ filename: "kafka-lag.md", title: "Kafka lag triage" }],
		});
		expect(messages).toHaveLength(2);
		const human = String(messages[1]?.content ?? "");
		expect(human).toContain("DEVOPS-1355");
		expect(human).toContain("DNS/network gap");
		expect(human).toContain("kafka-significant-lag");
		expect(human).toContain("kafka-lag.md");
	});

	test("states when no incident matched and the catalog is empty", () => {
		const messages = buildDistillerMessages({
			ticket: ticket(),
			incidentSummary: "",
			existingRootCause: null,
			runbookCatalog: [],
		});
		const human = String(messages[1]?.content ?? "");
		expect(human).toContain("No stored incident matched");
		expect(human).toContain("catalog is empty");
	});
});

describe("SIO-1126 parseLearningProposal", () => {
	test("parses a valid canned response", () => {
		const proposal = parseLearningProposal(CANNED_RESPONSE);
		expect(proposal).not.toBeNull();
		expect(proposal?.rootCause?.causeClass).toBe("route53-resolver-rule-vpc-association-missing");
		expect(proposal?.rootCause?.invalidatedHypotheses).toHaveLength(1);
		expect(proposal?.memoryFacts).toHaveLength(1);
		expect(proposal?.bindings).toHaveLength(0);
	});

	test("tolerates fenced JSON", () => {
		const proposal = parseLearningProposal(`Here you go:\n\n\`\`\`json\n${CANNED_RESPONSE}\n\`\`\``);
		expect(proposal?.rootCause?.causeClass).toBe("route53-resolver-rule-vpc-association-missing");
	});

	test("returns null for garbage and schema violations", () => {
		expect(parseLearningProposal("no json here")).toBeNull();
		// causeClass must be kebab-case; uppercase violates the schema.
		const bad = JSON.parse(CANNED_RESPONSE);
		bad.rootCause.causeClass = "NOT KEBAB";
		expect(parseLearningProposal(JSON.stringify(bad))).toBeNull();
		// evidence is mandatory per item.
		const noEvidence = JSON.parse(CANNED_RESPONSE);
		noEvidence.memoryFacts[0].evidence = [];
		expect(parseLearningProposal(JSON.stringify(noEvidence))).toBeNull();
	});
});
