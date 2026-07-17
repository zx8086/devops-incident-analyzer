// agent/src/learn/apply.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphStore } from "@devops-agent/knowledge-graph";
import type { LearningProposal } from "@devops-agent/shared";
import type { AgentStateType } from "../state.ts";
import { applyLearnings, buildApplyItems, buildApplySummary, composeRootCauseDescription } from "./apply.ts";

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

	// SIO-1127: an out-of-catalog (or absent) runbook no longer just skips -- it drafts a
	// PR-gated runbook. MEMORY_PR_ENABLED is unset in tests, so openMemoryPr self-skips
	// (no network); the apply summary reports the draft was not opened rather than linking.
	test("no catalog runbook -> a DRAFT runbook PR is attempted (self-skips without MEMORY_PR)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const p = proposal();
		if (p.rootCause) p.rootCause.runbookFilename = undefined; // no catalog match at all
		const result = await applyLearnings(
			stateWith({
				hilProposal: p,
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
			}),
		);

		// No RESOLVED_BY link (the PR self-skipped, so nothing to link).
		expect(calls.some((c) => c.cypher.includes("RESOLVED_BY"))).toBe(false);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("draft runbook PR not opened (skipped)");
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

	// SIO-1127: telemetry binding corrections. hasBinding returns [] from the stub (new
	// binding), so a confirm both records the edge AND mirrors the kg-binding fact.
	function bindingProposal(action: "confirm" | "invalidate"): LearningProposal {
		return {
			ticketKey: "DEVOPS-1355",
			rootCause: null,
			bindings: [
				{
					id: "bind-1",
					kind: "binding",
					action,
					service: "example-consumer-service",
					datasource: "kafka",
					bindingKind: "topic",
					resourceId: "orders.events",
					reason: "confirmed by ops",
					evidence: ["orders.events"],
				},
			],
			heuristics: [],
			memoryFacts: [],
		};
	}

	test("SIO-1127: a confirmed binding writes the OBSERVED_IN edge (human, confidence 1.0)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: bindingProposal("confirm"),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "approve" },
			}),
		);

		// The SET query (not the hasBinding count query) carries discoveredBy/confidence.
		const observed = calls.find((c) => c.cypher.includes("MERGE (s)-[o:OBSERVED_IN]"));
		expect(observed?.params?.discoveredBy).toBe("human");
		expect(observed?.params?.confidence).toBe(1.0);
		expect(observed?.params?.service).toBe("example-consumer-service");
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Confirmed 1 telemetry binding");
	});

	test("SIO-1127: an invalidated binding sets tInvalid without the human exclusion", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: bindingProposal("invalidate"),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "approve" },
			}),
		);

		const invalidate = calls.find((c) => c.cypher.includes("invalidated-by-human"));
		expect(invalidate).toBeDefined();
		expect(invalidate?.cypher).not.toContain("o.discoveredBy");
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Invalidated 1 stale telemetry binding");
	});

	test("SIO-1127: an unknown binding kind is skipped, not written", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const p = bindingProposal("confirm");
		p.bindings = p.bindings.map((b) => ({ ...b, bindingKind: "not-a-real-kind" }));
		const result = await applyLearnings(
			stateWith({
				hilProposal: p,
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "approve" },
			}),
		);

		expect(calls.some((c) => c.cypher.includes("OBSERVED_IN"))).toBe(false);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain('unknown binding kind "not-a-real-kind"');
	});

	test("SIO-1127: a rejected binding is not written", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		await applyLearnings(
			stateWith({
				hilProposal: bindingProposal("confirm"),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "reject" },
			}),
		);
		expect(calls.some((c) => c.cypher.includes("OBSERVED_IN"))).toBe(false);
	});

	// CodeRabbit PR #406: a throwing binding must soft-fail INDEPENDENTLY -- it is reported
	// skipped, and the incident curation (ticketKey link) still proceeds.
	test("SIO-1127: a throwing binding is skipped but curation still proceeds", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		// The OBSERVED_IN write throws; everything else works.
		const store = {
			init: async () => undefined,
			run: async (cypher: string, params?: Record<string, unknown>) => {
				calls.push({ cypher, params });
				if (cypher.includes("MERGE (s)-[o:OBSERVED_IN]")) throw new Error("boom");
				return [];
			},
			close: async () => undefined,
		} as GraphStore;
		_setGraphStoreForTesting(store);

		const result = await applyLearnings(
			stateWith({
				hilProposal: bindingProposal("confirm"),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "approve" },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Skipped bind-1: binding write failed");
		// Curation (SET i.ticketKey) still ran -- the throw did not abort it.
		expect(calls.some((c) => c.cypher.includes("SET i.ticketKey"))).toBe(true);
	});

	// CodeRabbit PR #406: the dedup check is scoped to the FULL datasource:kind:resourceId
	// identity -- the hasBinding count query must carry $datasource.
	test("SIO-1127: a confirmed binding dedups on the full datasource identity", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		await applyLearnings(
			stateWith({
				hilProposal: bindingProposal("confirm"),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "bind-1": "approve" },
			}),
		);
		const countQuery = calls.find((c) => c.cypher.includes("count(o) AS n"));
		expect(countQuery?.cypher).toContain("datasource: $datasource");
		expect(countQuery?.params?.datasource).toBe("kafka");
	});

	// SIO-1127: heuristics self-gate on live memory (unset in tests) -> reported as skipped,
	// never silently dropped. The skill-proposal write path itself is covered by the
	// buildSkillAnnotations/buildSkillFactText reuse (skill-learner tests).
	// SIO-1128: an edited rootCause.description is what lands in the recordRootCause write,
	// not the distiller's original -- proves applyEdits(state.hilProposal, state.hilEdits) is
	// actually merged before the graph write, not just carried in state unused.
	test("SIO-1128: an edited root-cause description is written (not the distiller original)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve" },
				hilEdits: { "rc-1": { description: "EDITED-DESC" } },
			}),
		);

		const nodeCall = calls.find((c) => c.cypher.includes("MERGE (rc:RootCause {id: $id})"));
		expect(String(nodeCall?.params?.description ?? "")).toContain("EDITED-DESC");
		expect(String(nodeCall?.params?.description ?? "")).not.toContain("Missing per-VPC resolver rule association");
	});

	test("SIO-1127: an approved heuristic is reported skipped when live memory is off", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		delete process.env.LIVE_MEMORY_ENABLED;
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const p: LearningProposal = {
			ticketKey: "DEVOPS-1355",
			rootCause: null,
			bindings: [],
			heuristics: [
				{
					id: "heur-1",
					kind: "heuristic",
					name: "resolver-check",
					description: "d",
					whenToUse: "broker id -1",
					procedure: "check resolver rules",
					evidence: ["check resolver rules"],
				},
			],
			memoryFacts: [],
		};
		const result = await applyLearnings(
			stateWith({
				hilProposal: p,
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "heur-1": "approve" },
			}),
		);
		const summary = String(result.messages?.[0]?.content ?? "");
		expect(summary).toContain("Skipped heur-1: live memory disabled");
	});
});

describe("SIO-1126 buildApplySummary", () => {
	const emptyReport = {
		ticketKey: "DEVOPS-1355",
		incidentId: "inc-1",
		incidentCreated: false,
		rootCauseWritten: false,
		factsWritten: 0,
		bindingsConfirmed: 0,
		bindingsInvalidated: 0,
		heuristicsProposed: 0,
		skipped: [],
		items: [],
	};

	test("reports the empty case", () => {
		const text = buildApplySummary(emptyReport, "DEVOPS-1355");
		expect(text).toContain("Nothing was approved");
	});

	// SIO-1127: Phase 2 lines render for bindings / heuristics / draft runbook.
	test("renders Phase 2 lines (bindings, heuristics, draft runbook PR)", () => {
		const text = buildApplySummary(
			{
				...emptyReport,
				bindingsConfirmed: 2,
				bindingsInvalidated: 1,
				heuristicsProposed: 1,
				draftRunbookUrl: "https://gitlab.com/x/-/merge_requests/7",
			},
			"DEVOPS-1355",
		);
		expect(text).toContain("Confirmed 2 telemetry binding");
		expect(text).toContain("Invalidated 1 stale telemetry binding");
		expect(text).toContain("Proposed 1 diagnostic skill");
		expect(text).toContain("DRAFT runbook PR for review: https://gitlab.com/x/-/merge_requests/7");
	});
});

// SIO-1146: the structured report returned as hilApplyReport drives the terminal
// outcome card; per-item statuses must reflect actual writes, not just decisions.
describe("SIO-1146 hilApplyReport items", () => {
	test("returns hilApplyReport with ticketKey and mixed applied/rejected statuses", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve", "fact-1": "reject" },
			}),
		);

		const report = result.hilApplyReport;
		expect(report).toBeDefined();
		if (!report) throw new Error("narrow");
		expect(report.ticketKey).toBe("DEVOPS-1355");
		expect(report.items.map((i) => [i.id, i.status])).toEqual([
			["rc-1", "applied"],
			["fact-1", "rejected"],
		]);
		// A rejected decision wins over the same-id "rejected" skip entry (no double-count).
		expect(report.items[1]?.reason).toBeUndefined();
	});

	test("KG disabled: approved root cause is skipped with the graph block reason", async () => {
		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve", "fact-1": "reject" },
			}),
		);

		const report = result.hilApplyReport;
		if (!report) throw new Error("narrow");
		const rcItem = report.items.find((i) => i.id === "rc-1");
		expect(rcItem?.status).toBe("skipped");
		expect(rcItem?.reason).toBe("knowledge graph disabled");
		expect(report.skipped.some((s) => s.id === "graph")).toBe(true);
	});

	// CodeRabbit PR #412: write FAILURES must surface as skip reasons, not the
	// vague "not written" fallback.
	test("graph write failure: approved root cause is skipped with the failure reason", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const throwingStore = {
			init: async () => undefined,
			run: async () => {
				throw new Error("store exploded");
			},
			close: async () => undefined,
		} as unknown as GraphStore;
		_setGraphStoreForTesting(throwingStore);

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "approve", "fact-1": "reject" },
			}),
		);

		const report = result.hilApplyReport;
		if (!report) throw new Error("narrow");
		const rcItem = report.items.find((i) => i.id === "rc-1");
		expect(rcItem?.status).toBe("skipped");
		expect(rcItem?.reason).toBe("graph write failed");
		expect(result.partialFailures).toEqual([{ node: "applyLearnings", reason: "graph-write-failed" }]);
	});

	test("live memory off: approved fact is skipped with the facts block reason", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const calls: RunCall[] = [];
		_setGraphStoreForTesting(stubStore(calls));

		const result = await applyLearnings(
			stateWith({
				hilProposal: proposal(),
				hilMatch: { incidentId: "inc-1", created: false },
				hilDecisions: { "rc-1": "reject", "fact-1": "approve" },
			}),
		);

		const report = result.hilApplyReport;
		if (!report) throw new Error("narrow");
		const factItem = report.items.find((i) => i.id === "fact-1");
		expect(factItem?.status).toBe("skipped");
		expect(factItem?.reason).toContain("live memory disabled");
	});

	test("buildApplyItems: applied wins over a same-id skip entry and keeps it as reason; labels truncate", () => {
		const longText = "x".repeat(300);
		const p = proposal({
			memoryFacts: [{ id: "fact-1", kind: "memory-fact", text: longText, evidence: ["e"] }],
		});
		const report = {
			ticketKey: "DEVOPS-1355",
			incidentId: "inc-1",
			incidentCreated: false,
			rootCauseWritten: true,
			factsWritten: 0,
			bindingsConfirmed: 0,
			bindingsInvalidated: 0,
			heuristicsProposed: 0,
			skipped: [{ id: "rc-1", reason: "draft runbook PR not opened (failed)" }],
			items: [],
		};
		const items = buildApplyItems(p, { "rc-1": "approve", "fact-1": "approve" }, report, new Set(["rc-1", "fact-1"]));
		const rcItem = items.find((i) => i.id === "rc-1");
		expect(rcItem?.status).toBe("applied");
		expect(rcItem?.reason).toBe("draft runbook PR not opened (failed)");
		const factItem = items.find((i) => i.id === "fact-1");
		expect(factItem?.status).toBe("applied");
		expect(factItem?.label.length).toBe(120);
		expect(factItem?.label.endsWith("...")).toBe(true);
	});
});
