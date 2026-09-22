// packages/agent/src/landing-zone/graph.test.ts

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildLandingZoneGraph } from "./graph.ts";
import { LandingZoneIntentSchema, LandingZoneStateInputSchema } from "./types.ts";

const EXPECTED_NODES = [
	"bootstrap",
	"classifyRequest",
	"resolveScope",
	"selectPvhKnowledge",
	"gatherEvidence",
	"reconcileEvidence",
	"assessRisk",
	"answerQuestion",
	"teardown",
];

const EXPECTED_EDGES = [
	["__start__", "bootstrap"],
	["bootstrap", "classifyRequest"],
	["classifyRequest", "resolveScope"],
	["resolveScope", "selectPvhKnowledge"],
	["selectPvhKnowledge", "gatherEvidence"],
	["gatherEvidence", "reconcileEvidence"],
	["reconcileEvidence", "assessRisk"],
	["assessRisk", "answerQuestion"],
	["answerQuestion", "teardown"],
	["teardown", "__end__"],
];

describe("Landing Zone state contract", () => {
	test("accepts the four supported intents", () => {
		expect(LandingZoneIntentSchema.options).toEqual(["learn", "understand", "review", "propose-change"]);
	});

	test("requires the complete read-only turn shape", () => {
		const parsed = LandingZoneStateInputSchema.parse({
			messages: [new HumanMessage("Explain account vending")],
			requestId: "request-1",
			intent: "learn",
			repositoryScope: ["aws-lz-account-creator"],
			accountScope: [],
			selectedKnowledge: ["repos/aws-lz-account-creator.md"],
			evidenceResults: [],
			reconciliation: null,
			risk: null,
			response: null,
			blockedReason: null,
			outcome: "pending",
			proposedChangeReview: null,
		});

		expect(parsed.requestId).toBe("request-1");
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

	test("persists the user-facing answer as the final assistant message", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const result = await graph.invoke(
			{ messages: [new HumanMessage("Explain account vending")], requestId: "request-answer" },
			{ configurable: { thread_id: "thread-answer" } },
		);

		expect(result.messages.at(-1)?.getType()).toBe("ai");
		expect(result.response).toBe("Live evidence not collected yet.");
		expect(result.messages.at(-1)?.content).toBe("Live evidence not collected yet.");
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
});
