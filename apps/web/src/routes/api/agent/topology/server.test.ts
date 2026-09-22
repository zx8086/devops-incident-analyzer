// apps/web/src/routes/api/agent/topology/server.test.ts

import { describe, expect, mock, test } from "bun:test";

const graphFor = mock(async () => ({
	getGraphAsync: async () => ({
		nodes: {
			__start__: {},
			bootstrap: {},
			classifyRequest: {},
			resolveScope: {},
			selectPvhKnowledge: {},
			gatherEvidence: {},
			reconcileEvidence: {},
			assessRisk: {},
			answerQuestion: {},
			teardown: {},
			__end__: {},
		},
		edges: [
			{ source: "__start__", target: "bootstrap" },
			{ source: "bootstrap", target: "classifyRequest" },
			{ source: "teardown", target: "__end__" },
		],
	}),
}));

mock.module("$lib/server/graph-registry", () => ({
	DEFAULT_AGENT_ID: "incident-analyzer",
	graphFor,
	isAgentId: (id: string) => ["incident-analyzer", "elastic-iac", "landing-zone-terraform"].includes(id),
}));

const { GET } = await import("./+server.ts");

describe("GET /api/agent/topology", () => {
	test("returns the Landing Zone compiled topology", async () => {
		const response = await GET({
			url: new URL("http://localhost/api/agent/topology?agent=landing-zone-terraform"),
		} as Parameters<typeof GET>[0]);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(graphFor).toHaveBeenCalledWith("landing-zone-terraform");
		expect(body.agent).toBe("landing-zone-terraform");
		expect(body.nodes).toContain("selectPvhKnowledge");
		expect(body.nodes).toContain("reconcileEvidence");
		expect(body.edges).toContainEqual({ source: "bootstrap", target: "classifyRequest", conditional: false });
	});
});
