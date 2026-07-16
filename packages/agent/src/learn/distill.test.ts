// agent/src/learn/distill.test.ts

import { describe, expect, test } from "bun:test";
import type { LearningProposal } from "@devops-agent/shared";
import {
	buildDistillerHumanText,
	buildDistillerMessages,
	parseLearningProposal,
	verifyProposalEvidence,
} from "./distill.ts";
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

describe("SIO-1126/SIO-1131 verifyProposalEvidence", () => {
	// SIO-1131: verification runs against EXACTLY the prompt text the model saw
	// (buildDistillerHumanText), never a re-rendered/re-redacted copy -- a
	// diverging haystack rejected every honest quote in production.
	const promptText = () =>
		buildDistillerHumanText({ ticket: ticket(), incidentSummary: "", existingRootCause: null, runbookCatalog: [] });

	test("keeps items whose evidence occurs in the prompt text", () => {
		const proposal = parseLearningProposal(CANNED_RESPONSE);
		if (!proposal) throw new Error("fixture must parse");
		const { proposal: verified, droppedIds } = verifyProposalEvidence(proposal, promptText());
		expect(droppedIds).toEqual([]);
		expect(verified.rootCause?.causeClass).toBe("route53-resolver-rule-vpc-association-missing");
		expect(verified.memoryFacts).toHaveLength(1);
	});

	test("drops items with hallucinated evidence (root cause -> null)", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		if (!parsed.rootCause) throw new Error("fixture must have a root cause");
		parsed.rootCause.evidence = ["this quote appears nowhere in the ticket"];
		const { proposal: verified, droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual(["rc-1"]);
		expect(verified.rootCause).toBeNull();
		// The grounded memory fact survives.
		expect(verified.memoryFacts).toHaveLength(1);
	});

	test("normalizes whitespace and case when matching quotes", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		fact.evidence = ["RESOLVER   associations are\nper-vpc and not transitive over the tgw."];
		const { droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual([]);
	});

	test("SIO-1131: quotes with markdown emphasis stripped still ground (**bold** source)", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		// Source description says "**Generated:** 2026-06-01..."-style markdown; the
		// model quotes it without the asterisks.
		fact.evidence = ["Agent report: SASL credential failure suspected."];
		const text = buildDistillerHumanText({
			ticket: ticket({ description: "**Agent report:** SASL credential failure _suspected_." }),
			incidentSummary: "",
			existingRootCause: null,
			runbookCatalog: [],
		});
		const { droppedIds } = verifyProposalEvidence(parsed, text);
		expect(droppedIds).toEqual([]);
	});

	test("SIO-1131: unicode punctuation folds (curly quotes, em-dash, ellipsis)", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		fact.evidence = ["the atom is “exhausting” its pool - permanently"];
		const base = ticket();
		const text = buildDistillerHumanText({
			ticket: ticket({
				comments: [
					...base.comments,
					{ author: "Ops Engineer", createdAt: "", body: 'the atom is "exhausting" its pool — permanently' },
				],
			}),
			incidentSummary: "",
			existingRootCause: null,
			runbookCatalog: [],
		});
		const { droppedIds } = verifyProposalEvidence(parsed, text);
		expect(droppedIds).toEqual([]);
	});

	test("SIO-1131: '...'-elided quotes ground when each substantial fragment occurs", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		fact.evidence = ["Root cause found: it's a DNS/network gap ... not transitive over the TGW."];
		const { droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual([]);
	});

	test("SIO-1131: elided quotes with a hallucinated fragment still drop", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		fact.evidence = ["Root cause found: it's a DNS/network gap ... the moon phase was unfavourable."];
		const { droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual(["fact-1"]);
	});

	test("PR #396 review: a SHORT hallucinated fragment cannot ride along on a grounded head", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		// "fabricated!" is under the 12-char substantial threshold; it must still
		// be checked (and fail) rather than being filtered out before grounding.
		fact.evidence = ["Resolver associations are per-VPC ... fabricated!"];
		const { droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual(["fact-1"]);
	});

	test("PR #396 review: an elided quote made only of tiny shards is not grounding", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		// Every fragment occurs in the haystack, but none is substantial.
		fact.evidence = ["the ... and ... over the"];
		const { droppedIds } = verifyProposalEvidence(parsed, promptText());
		expect(droppedIds).toEqual(["fact-1"]);
	});

	test("SIO-1131: quotes from the context block ground too (same prompt text)", () => {
		const parsed = JSON.parse(CANNED_RESPONSE) as LearningProposal;
		const fact = parsed.memoryFacts[0];
		if (!fact) throw new Error("fixture must have a memory fact");
		fact.evidence = ["Matched stored incident: prior investigation of the consumer service"];
		const text = buildDistillerHumanText({
			ticket: ticket(),
			incidentSummary: "prior investigation of the consumer service",
			existingRootCause: null,
			runbookCatalog: [],
		});
		const { droppedIds } = verifyProposalEvidence(parsed, text);
		expect(droppedIds).toEqual([]);
	});
});
