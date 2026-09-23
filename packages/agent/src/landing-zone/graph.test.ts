// packages/agent/src/landing-zone/graph.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import type { LandingZoneEvidenceCollectors } from "./evidence.ts";
import { buildLandingZoneGraph } from "./graph.ts";
import { answerLandingZoneQuestion, assessLandingZoneRisk } from "./nodes.ts";
import type { LandingZoneStateType } from "./state.ts";
import { LandingZoneIntentSchema, LandingZoneStateInputSchema } from "./types.ts";

const EXPECTED_NODES = [
	"bootstrap",
	"classifyRequest",
	"resolveScope",
	"recallMemory",
	"selectPvhKnowledge",
	"collectGitLabEvidence",
	"collectOkfEvidence",
	"collectTerraformDocsEvidence",
	"collectAwsDocsEvidence",
	"collectAwsApiEvidence",
	"collectMemoryEvidence",
	"collectKnowledgeGraphEvidence",
	"joinEvidence",
	"reconcileEvidence",
	"assessRisk",
	"answerQuestion",
	"draftChange",
	"validateCandidate",
	"prepareReview",
	"reviewGate",
	"openMergeRequest",
	"watchPipeline",
	"recordOutcome",
	"projectTopology",
	"teardown",
];

const EXPECTED_EDGES = [
	["__start__", "bootstrap"],
	["bootstrap", "classifyRequest"],
	["classifyRequest", "resolveScope"],
	["resolveScope", "recallMemory"],
	["recallMemory", "selectPvhKnowledge"],
	["joinEvidence", "reconcileEvidence"],
	["reconcileEvidence", "assessRisk"],
	["assessRisk", "answerQuestion"],
	["answerQuestion", "projectTopology"],
	["watchPipeline", "recordOutcome"],
	["recordOutcome", "teardown"],
	["projectTopology", "teardown"],
	["teardown", "__end__"],
];

const BASE_STATE_INPUT = {
	messages: [new HumanMessage("Explain account vending")],
	requestId: "request-1",
	intent: "learn",
	repositoryScope: ["aws-lz-account-creator"],
	accountScope: [],
	authorizedAccountScope: [],
	selectedKnowledge: ["repos/aws-lz-account-creator.md"],
	gitlabEvidence: null,
	okfEvidence: null,
	terraformDocsEvidence: null,
	awsDocsEvidence: null,
	awsApiEvidence: null,
	memoryEvidence: null,
	knowledgeGraphEvidence: null,
	evidenceResults: [],
	priorMemory: [],
	reconciliation: null,
	risk: null,
	response: null,
	responseCitations: [],
	topologyStates: [],
	blockedReason: null,
	outcome: "pending",
	changeCandidate: null,
	candidateValidations: [],
	candidateValidationPassed: false,
	proposedChangeReview: null,
	reviewDecision: null,
	amendmentInstructions: null,
	proposalIteration: 0,
	mergeRequest: null,
	pipelineObservation: null,
} as const;

const observedEvidence = {
	id: "gitlab:account-creator:abc123",
	claimKey: "account-authoring-surface",
	claimValue: "accounts/*.yml",
	source: "gitlab",
	retrievedAt: "2026-09-22T10:30:00.000Z",
	status: "observed",
	summary: "Account requests are authored in YAML.",
	provenance: { repository: "aws-lz-account-creator", path: "accounts/example.yml" },
	freshness: { status: "current" },
} as const;

function proposedChangeState(evidenceResults: EvidenceItem[]): LandingZoneStateType {
	return {
		messages: [],
		requestId: "risk-request",
		intent: "propose-change",
		repositoryScope: ["aws-lz-account-creator"],
		accountScope: [],
		authorizedAccountScope: [],
		selectedKnowledge: [],
		gitlabEvidence: null,
		okfEvidence: null,
		terraformDocsEvidence: null,
		awsDocsEvidence: null,
		awsApiEvidence: null,
		memoryEvidence: null,
		knowledgeGraphEvidence: null,
		evidenceResults,
		priorMemory: [],
		reconciliation: {
			status: "pending",
			conclusion: "Some evidence was collected.",
			comparisons: [],
			conflicts: [],
			unavailableSources: [],
		},
		risk: null,
		response: null,
		responseCitations: [],
		topologyStates: [],
		landingZoneTopology: null,
		blockedReason: null,
		outcome: "pending",
		changeCandidate: null,
		candidateValidations: [],
		candidateValidationPassed: false,
		proposedChangeReview: null,
		reviewDecision: null,
		amendmentInstructions: null,
		proposalIteration: 0,
		mergeRequest: null,
		pipelineObservation: null,
	};
}

function successfulCollectors(calls: EvidenceSource[]): LandingZoneEvidenceCollectors {
	const sources: EvidenceSource[] = [
		"pvh-okf",
		"gitlab",
		"terraform-docs",
		"aws-docs",
		"aws-api",
		"memory",
		"knowledge-graph",
	];
	return Object.fromEntries(
		sources.map((source) => [
			source,
			async () => {
				calls.push(source);
				return [{ ...observedEvidence, id: `${source}:graph`, source }];
			},
		]),
	) as unknown as LandingZoneEvidenceCollectors;
}

describe("Landing Zone state contract", () => {
	test("accepts the four supported intents", () => {
		expect(LandingZoneIntentSchema.options).toEqual(["learn", "understand", "review", "propose-change"]);
	});

	test("requires the complete read-only turn shape", () => {
		const parsed = LandingZoneStateInputSchema.parse(BASE_STATE_INPUT);

		expect(parsed.requestId).toBe("request-1");
	});

	test("rejects citations and topology states that reference missing evidence", () => {
		const parsed = LandingZoneStateInputSchema.safeParse({
			...BASE_STATE_INPUT,
			responseCitations: [{ id: "citation-1", claim: "A claim", evidenceIds: ["missing"] }],
			topologyStates: [
				{
					resourceKey: "vpc-1",
					state: "observed",
					reconciliationStatus: "aligned",
					evidenceIds: ["missing"],
				},
			],
		});

		expect(parsed.success).toBeFalse();
	});
});

describe("Landing Zone required evidence gate", () => {
	test("does not let non-GitLab evidence clear a proposed change", async () => {
		const result = await assessLandingZoneRisk(
			proposedChangeState([{ ...observedEvidence, id: "memory:1", source: "memory" }]),
		);

		expect(result.risk?.blocked).toBeTrue();
		expect(result.blockedReason).toContain("gitlab");
	});

	test("accepts current observed GitLab evidence for the required source", async () => {
		const result = await assessLandingZoneRisk(proposedChangeState([observedEvidence]));

		expect(result.risk?.blocked).toBeFalse();
		expect(result.blockedReason).toBeNull();
	});

	test("does not treat stale GitLab evidence as usable for a proposed change", async () => {
		const result = await assessLandingZoneRisk(
			proposedChangeState([{ ...observedEvidence, freshness: { status: "stale" } }]),
		);

		expect(result.risk?.blocked).toBeTrue();
		expect(result.blockedReason).toContain("gitlab");
	});

	test("does not let proposed GitLab evidence substitute for observed repository state", async () => {
		const result = await assessLandingZoneRisk(proposedChangeState([{ ...observedEvidence, status: "proposed" }]));

		expect(result.risk?.blocked).toBeTrue();
		expect(result.blockedReason).toContain("gitlab");
	});
});

describe("Landing Zone memory answer boundary", () => {
	test("does not expose prior memory in a blocked response", async () => {
		const result = await answerLandingZoneQuestion({
			...proposedChangeState([]),
			blockedReason: "Current GitLab evidence is required.",
			priorMemory: [
				{
					text: "A stale account value.",
					annotations: {
						kind: "account-vending",
						validated_claims: JSON.stringify({ "account-authoring-surface": "accounts/*.yml" }),
					},
					advisory: true,
					requiresLiveRevalidation: true,
				},
			],
		});

		expect(result.response).toBe("Current GitLab evidence is required.");
		expect(result.response).not.toContain("stale account value");
	});

	test("shows advisory prior experience only after live evidence aligns", async () => {
		const result = await answerLandingZoneQuestion({
			...proposedChangeState([observedEvidence]),
			intent: "review",
			blockedReason: null,
			reconciliation: {
				status: "aligned",
				conclusion: "Live evidence is aligned.",
				comparisons: [],
				conflicts: [],
				unavailableSources: [],
			},
			priorMemory: [
				{
					text: "A previous review used account YAML.",
					annotations: {
						kind: "account-vending",
						validated_claims: JSON.stringify({ "account-authoring-surface": "accounts/*.yml" }),
					},
					advisory: true,
					requiresLiveRevalidation: true,
				},
			],
		});

		expect(result.response).toContain("Prior experience (advisory; revalidate against current live evidence)");
		expect(result.response).toContain("A previous review used account YAML.");
	});
});

describe("buildLandingZoneGraph", () => {
	test("compiles with the repository checkpointer and exposes the read-only topology", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		expect(typeof graph.streamEvents).toBe("function");
		expect(typeof graph.getState).toBe("function");

		const drawable = await graph.getGraphAsync();
		for (const node of EXPECTED_NODES) {
			expect(Object.keys(drawable.nodes)).toContain(node);
		}

		const edges = drawable.edges.map((edge) => [edge.source, edge.target]);
		for (const edge of EXPECTED_EDGES) {
			expect(edges).toContainEqual(edge);
		}
		for (const collector of EXPECTED_NODES.filter((node) => node.startsWith("collect"))) {
			expect(edges).toContainEqual(["selectPvhKnowledge", collector]);
			expect(edges).toContainEqual([collector, "joinEvidence"]);
		}
	});

	test("keeps informational account-creation questions out of the change path", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("How does PVH create an AWS account?")], requestId: "request-learn" },
			{ configurable: { thread_id: "thread-learn" } },
		);

		expect(result.intent).toBe("learn");
		expect(result.outcome).toBe("answered");
	});

	test("fans injected collectors into the join and leaves unauthorised AWS live state uncalled", async () => {
		const calls: EvidenceSource[] = [];
		const graph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: successfulCollectors(calls),
		});
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Review account vending")], requestId: "request-fanout" },
			{ configurable: { thread_id: "thread-fanout" } },
		);

		expect(calls).toContainAllValues(["pvh-okf", "gitlab", "terraform-docs", "aws-docs", "memory", "knowledge-graph"]);
		expect(calls).not.toContain("aws-api");
		expect(result.evidenceResults.map((item) => item.source)).toContain("gitlab");
	});

	test("projects graph-recorded topology on the production graph path", async () => {
		const calls: EvidenceSource[] = [];
		const topologyFact = {
			id: "vpc-1",
			fact: {
				id: "vpc-1",
				kind: "vpc",
				name: "workload-vpc",
				accountId: "111122223333",
				properties: {},
				provenance: {
					state: "observed",
					source: "aws-api",
					resourceId: "vpc-1",
					observedAt: "2026-09-23T08:00:00.000Z",
				},
			},
			provenance: [
				{
					state: "observed",
					source: "aws-api",
					resourceId: "vpc-1",
					observedAt: "2026-09-23T08:00:00.000Z",
				},
			],
			reconciliation: { status: "aligned", confidence: "verified" },
			validFrom: "2026-09-23T08:00:00.000Z",
			consecutiveMisses: 0,
		};
		const graph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: successfulCollectors(calls),
			topologyTools: [
				{
					name: "kg_run_cypher",
					invoke: async () => ({
						content: [{ type: "text", text: JSON.stringify([{ payload: JSON.stringify(topologyFact) }]) }],
					}),
				},
			],
		});
		const result = await graph.invoke(
			{
				messages: [new HumanMessage("Show the network topology for account 111122223333")],
				authorizedAccountScope: ["111122223333"],
			},
			{ configurable: { thread_id: "thread-topology" } },
		);
		expect(result.accountScope).toEqual(["111122223333"]);
		expect(result.landingZoneTopology?.topology.nodes.map((node) => node.id)).toEqual(["vpc-1"]);
	});

	test("persists the user-facing answer as the final assistant message", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Explain account vending")], requestId: "request-answer" },
			{ configurable: { thread_id: "thread-answer" } },
		);

		expect(result.messages.at(-1)?.getType()).toBe("ai");
		expect(result.response).toContain(
			"Available evidence supports an explanation, but the full contract is not yet corroborated.",
		);
		expect(result.response).toContain("general guidance only");
		if (!result.response) throw new Error("expected a user-facing response");
		expect(result.messages.at(-1)?.content).toBe(result.response);
	});

	test("still blocks an imperative account-creation request without live evidence", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Create an AWS account for MarTech")], requestId: "request-change" },
			{ configurable: { thread_id: "thread-change" } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.outcome).toBe("blocked");
	});

	test("fails closed when an informational request also asks for a change", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{
				messages: [new HumanMessage("Explain account vending and create an AWS account for MarTech")],
				requestId: "request-mixed",
			},
			{ configurable: { thread_id: "thread-mixed" } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.requiresHumanDecision).toBeTrue();
		expect(result.outcome).toBe("blocked");
	});

	test("treats creating a review as review work rather than an infrastructure mutation", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Create a review of the VPC network configuration")], requestId: "request-review" },
			{ configurable: { thread_id: "thread-review" } },
		);

		expect(result.intent).toBe("review");
		expect(result.outcome).toBe("answered");
	});

	test("treats creating an example as learning rather than an infrastructure mutation", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Create an example of PVH account vending")], requestId: "request-example" },
			{ configurable: { thread_id: "thread-example" } },
		);

		expect(result.intent).toBe("learn");
		expect(result.outcome).toBe("answered");
	});

	test("keeps change verbs inside an explanatory how-clause informational", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{
				messages: [new HumanMessage("Explain the process, including how you create and update VPC subnets")],
				requestId: "request-explanatory-how",
			},
			{ configurable: { thread_id: "thread-explanatory-how" } },
		);

		expect(result.intent).toBe("learn");
		expect(result.outcome).toBe("answered");
	});

	test("fails closed when a how-question appends an infrastructure mutation", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{
				messages: [new HumanMessage("How does account vending work and update the VPC")],
				requestId: "request-how-change",
			},
			{ configurable: { thread_id: "thread-how-change" } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.requiresHumanDecision).toBeTrue();
		expect(result.outcome).toBe("blocked");
	});

	test("treats a modal request to create a plan as review work", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Could you create a plan for the network?")], requestId: "request-modal-plan" },
			{ configurable: { thread_id: "thread-modal-plan" } },
		);

		expect(result.intent).toBe("review");
		expect(result.outcome).toBe("answered");
	});

	test("fails closed for a comma-separated mutation after an informational artifact", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{
				messages: [
					new HumanMessage("Create a review of the VPC configuration, update the transit gateway to add peering"),
				],
				requestId: "request-artifact-change",
			},
			{ configurable: { thread_id: "thread-artifact-change" } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.requiresHumanDecision).toBeTrue();
		expect(result.outcome).toBe("blocked");
	});

	test.each([
		["Apply a plan that destroys the KMS key", "destructive plan"],
		["Allow public access from 0.0.0.0/0", "Public access"],
		["Grant IAM Action * and Resource *", "Broad IAM"],
		["Commit a plaintext secret in tfvars", "Secrets and credentials"],
		["Delete the workload VPC resource", "destructive plan"],
		["Remove the subnet resource", "destructive plan"],
		["Migrate backend locking", "Backend and locking"],
	] as const)("routes high-risk imperative requests through the stop gates: %s", async (request, reason) => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage(request)], requestId: `request-stop-${reason}` },
			{ configurable: { thread_id: `thread-stop-${reason}` } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.blocked).toBeTrue();
		expect(result.risk?.stopConditions.join(" ")).toContain(reason);
	});

	test.each([
		"What permissions does this policy grant?",
		"Which commit removed the subnet?",
		"Why was public access allowed?",
	] as const)("keeps informational questions out of mutation stop gates: %s", async (request) => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage(request)], requestId: `request-question-${request}` },
			{ configurable: { thread_id: `thread-question-${request}` } },
		);

		expect(result.intent).not.toBe("propose-change");
		expect(result.outcome).toBe("answered");
	});

	test("still fails closed when an informational question appends a destructive request", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{
				messages: [new HumanMessage("Which commit removed the subnet, and delete the workload VPC resource")],
				requestId: "request-question-then-delete",
			},
			{ configurable: { thread_id: "thread-question-then-delete" } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.stopConditions.join(" ")).toContain("destructive plan");
	});

	test.each([
		"Which subnet should we remove?",
		"What IAM permissions could we grant?",
		"Which workload VPC to delete?",
	] as const)("routes prospective change questions through mutation stop gates: %s", async (request) => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage(request)], requestId: `request-prospective-${request}` },
			{ configurable: { thread_id: `thread-prospective-${request}` } },
		);

		expect(result.intent).toBe("propose-change");
		expect(result.risk?.blocked).toBeTrue();
	});
});
