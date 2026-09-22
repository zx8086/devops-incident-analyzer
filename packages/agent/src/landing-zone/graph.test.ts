// agent/src/landing-zone/graph.test.ts

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
});
