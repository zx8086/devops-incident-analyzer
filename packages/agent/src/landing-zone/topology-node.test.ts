// packages/agent/src/landing-zone/topology-node.test.ts

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { LandingZoneStateType } from "./state.ts";
import { type LandingZoneTopologyTool, projectLandingZoneTopologyNode } from "./topology-node.ts";

const provenance = {
	state: "observed" as const,
	source: "aws-api" as const,
	resourceId: "vpc-1",
	observedAt: "2026-09-23T08:00:00.000Z",
};

const vpcFact = {
	id: "vpc-1",
	fact: {
		id: "vpc-1",
		kind: "vpc",
		name: "workload-vpc",
		accountId: "111122223333",
		region: "eu-central-1",
		properties: { cidr: "10.0.0.0/16" },
		provenance,
	},
	provenance: [provenance],
	reconciliation: { status: "aligned", confidence: "verified" },
	validFrom: "2026-09-23T08:00:00.000Z",
	observedAt: "2026-09-23T08:00:00.000Z",
	consecutiveMisses: 0,
};

function state(
	prompt: string,
	options: { accountScope?: string[]; authorizedAccountScope?: string[] } = {},
): LandingZoneStateType {
	return {
		messages: [new HumanMessage(prompt)],
		requestId: "request-1",
		intent: "understand",
		requestResolution: null,
		clarificationCount: 0,
		repositoryScope: [],
		accountScope: options.accountScope ?? ["111122223333"],
		authorizedAccountScope: options.authorizedAccountScope ?? ["111122223333"],
		selectedKnowledge: [],
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
		answerResult: null,
		answerValidation: null,
		answerRetryCount: 0,
	};
}

describe("projectLandingZoneTopologyNode", () => {
	test("queries current graph facts and produces a network event for an explicit topology request", async () => {
		const calls: Record<string, unknown>[] = [];
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async (input) => {
				calls.push(input);
				return { content: [{ type: "text", text: JSON.stringify([{ payload: JSON.stringify(vpcFact) }]) }] };
			},
		};
		const result = await projectLandingZoneTopologyNode(state("Show the network topology for account 111122223333"), {
			tools: [tool],
		});
		expect(result.landingZoneTopology?.type).toBe("landing_zone_topology");
		expect(result.landingZoneTopology?.view).toBe("network");
		expect(result.landingZoneTopology?.topology.nodes.map((node) => node.id)).toEqual(["vpc-1"]);
		expect(calls[0]).toMatchObject({
			params: { accountIds: ["111122223333"], offset: 0, pageSize: 500 },
		});
	});

	test("does not query Landing Zone topology when only a different account is independently authorized", async () => {
		let calls = 0;
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async () => {
				calls += 1;
				return {};
			},
		};
		const result = await projectLandingZoneTopologyNode(
			state("Show the network topology for account 999900001111", {
				accountScope: ["999900001111"],
				authorizedAccountScope: ["111122223333"],
			}),
			{ tools: [tool] },
		);
		expect(result.landingZoneTopology).toBeNull();
		expect(calls).toBe(0);
	});

	test("does not query topology until a Landing Zone account is established", async () => {
		let calls = 0;
		const result = await projectLandingZoneTopologyNode(
			state("Show the network topology", { accountScope: [], authorizedAccountScope: [] }),
			{
				tools: [
					{
						name: "kg_run_cypher",
						invoke: async () => {
							calls += 1;
							return {};
						},
					},
				],
			},
		);
		expect(result.landingZoneTopology).toBeNull();
		expect(calls).toBe(0);
	});

	test("paginates current facts and marks the projection when the safety bound is reached", async () => {
		const calls: Record<string, unknown>[] = [];
		const facts = [0, 1, 2, 3, 4].map((index) => ({
			...vpcFact,
			id: `vpc-${index}`,
			fact: { ...vpcFact.fact, id: `vpc-${index}`, name: `workload-vpc-${index}` },
		}));
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async (input) => {
				calls.push(input);
				const offset = (input.params as { offset: number }).offset;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(facts.slice(offset, offset + 2).map((fact) => ({ payload: JSON.stringify(fact) }))),
						},
					],
				};
			},
		};
		const result = await projectLandingZoneTopologyNode(state("Show the network topology"), {
			tools: [tool],
			pageSize: 2,
			maxPages: 2,
		});
		expect(calls.map((call) => (call.params as { offset: number }).offset)).toEqual([0, 2, 4]);
		expect(result.landingZoneTopology?.topology.nodes).toHaveLength(4);
		expect(result.landingZoneTopology?.topology.truncated).toBe(true);
	});

	test("does not mark an exactly full bounded result as truncated", async () => {
		const facts = [0, 1, 2, 3].map((index) => ({
			...vpcFact,
			id: `vpc-${index}`,
			fact: { ...vpcFact.fact, id: `vpc-${index}`, name: `workload-vpc-${index}` },
		}));
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async (input) => {
				const { offset, pageSize } = input.params as { offset: number; pageSize: number };
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								facts.slice(offset, offset + pageSize).map((fact) => ({ payload: JSON.stringify(fact) })),
							),
						},
					],
				};
			},
		};
		const result = await projectLandingZoneTopologyNode(state("Show the network topology"), {
			tools: [tool],
			pageSize: 2,
			maxPages: 2,
		});
		expect(result.landingZoneTopology?.topology.nodes).toHaveLength(4);
		expect(result.landingZoneTopology?.topology.truncated).toBe(false);
	});

	test("does not query the graph for a non-topology answer", async () => {
		let calls = 0;
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async () => {
				calls += 1;
				return {};
			},
		};
		const result = await projectLandingZoneTopologyNode(state("Explain account vending"), { tools: [tool] });
		expect(result.landingZoneTopology).toBeNull();
		expect(calls).toBe(0);
	});

	test("fails closed when graph evidence is unavailable", async () => {
		const tool: LandingZoneTopologyTool = {
			name: "kg_run_cypher",
			invoke: async () => {
				throw new Error("graph unavailable");
			},
		};
		const result = await projectLandingZoneTopologyNode(state("Show a DNS diagram for api.internal.pvh"), {
			tools: [tool],
		});
		expect(result.landingZoneTopology).toBeNull();
	});
});
