// agent/src/learn/apply.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphStore } from "@devops-agent/knowledge-graph";
import type { LearningProposal } from "@devops-agent/shared";
import type { AgentStateType } from "../state.ts";
import { applyLearnings, buildApplySummary, composeRootCauseDescription } from "./apply.ts";

interface RunCall {
	cypher: string;
	params?: Record<string, unknown>;
}

function stubStore(calls: RunCall[]): GraphStore {
	return {
		init: async () => undefined,
		run: async (cypher: string, params?: Record<string, unknown>) => {
			calls.push({ cypher, params });
			return [];
		},
		close: async () => undefined,
	} as GraphStore;
}

function proposal(overrides: Partial<LearningProposal> = {}): LearningProposal {
	return {
		ticketKey: "DEVOPS-1355",
		rootCause: {
			id: "rc-1",
			kind: "root-cause",
			causeClass: "route53-resolver-rule-vpc-association-missing",
			description: "Missing per-VPC resolver rule association; timeout mimicked an auth failure.",
			resolution: "Associate the resolver rule via the infrastructure repo.",
			invalidatedHypotheses: [{ hypothesis: "invalid SSM credential", reason: "client never connects" }],
			evidence: ["Root cause found: it's a DNS/network gap, not credentials."],
		},
		bindings: [],
		heuristics: [],
		memoryFacts: [
			{
				id: "fact-1",
				kind: "memory-fact",
				text: "Resolver rule associations are per-VPC and not transitive over the TGW.",
				evidence: ["Resolver associations are per-VPC and not transitive over the TGW."],
			},
		],
		...overrides,
	};
}

function stateWith(overrides: Partial<AgentStateType>): AgentStateType {
	return { requestId: "req-1", ...overrides } as AgentStateType;
}

afterEach(() => {
	delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	_setGraphStoreForTesting(null);
});

describe("SIO-1126 composeRootCauseDescription", () => {
	test("folds resolution + ruled-out hypotheses + ticket provenance into one string", () => {
		const p = proposal();
		const rc = p.rootCause;
		if (!rc) throw new Error("fixture must have a root cause");
		const text = composeRootCauseDescription(rc, "DEVOPS-1355");
		expect(text).toContain("Missing per-VPC resolver rule association");
		expect(text).toContain("Resolution: Associate the resolver rule");
		expect(text).toContain("Ruled out: invalid SSM credential -- client never connects");
		expect(text).toContain("(human-corrected via DEVOPS-1355)");
	});

	test("caps very long descriptions", () => {
		const p = proposal();
		const rc = p.rootCause;
		if (!rc) throw new Error("fixture must have a root cause");
		const text = composeRootCauseDescription({ ...rc, description: "x".repeat(2_000) }, "DEVOPS-1355");
		expect(text.length).toBeLessThanOrEqual(700);
	});
});

describe("SIO-1126 applyLearnings", () => {
	test("returns {} when the proposal or decisions are missing", async () => {
		expect(await applyLearnings(stateWith({}))).toEqual({});
		expect(await applyLearnings(stateWith({ hilProposal: proposal() }))).toEqual({});
	});

	test("writes the human root cause (replace edge, confidence 1) and mirrors nothing to a disabled graph", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve", "fact-1": "approve" },
			}),
		);

		const cypher = calls.map((c) => c.cypher).join("\n");
		expect(cypher).toContain("MERGE (rc:RootCause {id: $id})");
		// A correction REPLACES the machine cause: the prior edge is deleted first.
		expect(cypher).toContain("DELETE r");
		const edgeCall = calls.find((c) => c.cypher.includes("MERGE (i)-[r:HAS_ROOT_CAUSE]->(rc)"));
		expect(edgeCall?.params?.confidence).toBe(1.0);
		expect(edgeCall?.params?.ruleName).toBe("route53-resolver-rule-vpc-association-missing");

		// No runbookFilename in the proposal -> no RESOLVED_BY write.
		expect(cypher).not.toContain("RESOLVED_BY");

		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Learned from DEVOPS-1355");
		expect(summary).toContain("human-corrected root cause");
	});

	test("SIO-1134: applying curates the incident (ticketKey written + summary line)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
			}),
		);

		const link = calls.find((c) => c.cypher.includes("SET i.ticketKey = $ticketKey"));
		expect(link?.params?.ticketKey).toBe("DEVOPS-1355");
		expect(link?.params?.id).toBe("inc-1");
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("canonical record");
	});

	test("SIO-1135: curating an EXISTING incident reads the row for the mirror fact", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		// Return an incident row for the incidentById node query so writeCurationMirrorFacts
		// has something to mirror; everything else returns []. The HIL rootCause path already
		// wrote a kg-root-cause this turn, so the mirror helper must SKIP the root-cause read.
		const store = {
			init: async () => undefined,
			run: async (cypher: string, params?: Record<string, unknown>) => {
				calls.push({ cypher, params });
				if (cypher.includes("RETURN i.id AS id, i.summary AS summary, i.severity AS severity LIMIT 1")) {
					return [{ id: "inc-1", summary: "resolver rule gap", severity: "high" }];
				}
				return [];
			},
			close: async () => undefined,
		} as GraphStore;
		_setGraphStoreForTesting(store);

		await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
			}),
		);

		// The mirror helper read the incident row by id (the kg-incident fact source).
		expect(calls.some((c) => c.cypher.includes("MATCH (i:Incident {id: $id})") && c.params?.id === "inc-1")).toBe(true);
		// It did NOT re-read the root cause: the HIL rootCause path wrote kg-root-cause already.
		expect(calls.some((c) => c.cypher.includes("HAS_ROOT_CAUSE") && c.cypher.includes("RETURN rc.id"))).toBe(false);
	});

	test("a rejected root cause is skipped and reported", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "reject", "fact-1": "reject" },
			}),
		);

		expect(calls.some((c) => c.cypher.includes("RootCause"))).toBe(false);
		// SIO-1134 + CodeRabbit PR #398: a full rejection must NOT curate -- with
		// auto-confirmed matches, "Reject all" is the escape from a wrong match.
		expect(calls.some((c) => c.cypher.includes("SET i.ticketKey"))).toBe(false);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Skipped rc-1: rejected");
		expect(summary).not.toContain("canonical record");
		expect(summary).toContain("Skipped curation: nothing approved; ticket link not written");
	});

	test("an out-of-catalog runbook is not linked", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const p = proposal();
		if (p.rootCause) p.rootCause.runbookFilename = "not-in-catalog.md";
		const result = await applyLearnings(
			stateWith({
				hilProposal: p,
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
			}),
		);

		expect(calls.some((c) => c.cypher.includes("RESOLVED_BY"))).toBe(false);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("not-in-catalog.md is not in the catalog");
	});

	test("a 'none of these' match creates the incident (embedding via the drop/set/recreate path)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "jira:DEVOPS-1355", created: true },
				hilTicketEmbedding: [0.1, 0.2],
				hilTicket: {
					key: "DEVOPS-1355",
					summary: "MSK Kafka controller election storm",
					status: "In Progress",
					description: "",
					comments: [],
				},
				hilDecisions: { "rc-1": "approve" },
			}),
		);

		const cypher = calls.map((c) => c.cypher).join("\n");
		expect(cypher).toContain("MERGE (i:Incident {id: $id})");
		// Vector-indexed column: never a bare SET without the index drop first.
		expect(cypher).toContain("DROP_VECTOR_INDEX");
		expect(cypher).toContain("SET i.embedding = $embedding");
	});

	test("graph disabled: apply still completes with a skip note", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("knowledge graph disabled");
	});

	test("a MISSING decision entry is rejected, never silently approved", async () => {
		// Explicit approval required: a partial/malformed resume payload must not
		// write unreviewed learnings (CodeRabbit, PR #392).
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: {}, // no entries at all
			}),
		);

		expect(calls.some((c) => c.cypher.includes("RootCause"))).toBe(false);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Skipped rc-1: rejected");
	});

	test("facts are not claimed as written when live memory is disabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		// LIVE_MEMORY_ENABLED is unset in tests -> recordKeyDecision no-ops.
		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve", "fact-1": "approve" },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).not.toContain("durable memory fact");
		expect(summary).toContain("live memory disabled");
	});

	test("alreadyLearned skips memory-fact re-writes", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilAlreadyLearned: true,
				hilDecisions: { "rc-1": "approve", "fact-1": "approve" },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("already learned from DEVOPS-1355");
		expect(summary).not.toContain("durable memory fact");
	});
});

describe("SIO-1126 buildApplySummary", () => {
	test("reports the empty case", () => {
		const text = buildApplySummary(
			{ incidentId: "inc-1", incidentCreated: false, rootCauseWritten: false, factsWritten: 0, skipped: [] },
			"DEVOPS-1355",
		);
		expect(text).toContain("Nothing was approved");
	});
});
