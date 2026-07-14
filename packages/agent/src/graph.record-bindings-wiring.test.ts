// packages/agent/src/graph.record-bindings-wiring.test.ts
//
// SIO-1100: verify the recordBindings node is registered and, when the knowledge
// graph is enabled, edged into the mitigation tail as
// recordRootCause -> recordBindings -> followUp. Introspects the compiled graph
// structure (no live LLM/MCP needed).

import { afterEach, describe, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: LangGraph's drawable-graph shape is untyped here; we only read ids.
function edgeList(drawable: any): string[] {
	return (drawable.edges ?? []).map((e: { source: string; target: string }) => `${e.source}->${e.target}`);
}

afterEach(() => {
	delete process.env.KNOWLEDGE_GRAPH_ENABLED;
});

describe("SIO-1100 recordBindings wiring", () => {
	test("KG enabled: recordBindings is registered and edged recordRootCause -> recordBindings -> followUp", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const { buildGraph } = await import("./graph.ts");
		const drawable = (await buildGraph()).getGraph();
		const edges = edgeList(drawable);
		expect(edges).toContain("recordRootCause->recordBindings");
		expect(edges).toContain("recordBindings->followUp");
	});

	test("KG disabled: aggregateMitigation bypasses the graph nodes straight to followUp", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const { buildGraph } = await import("./graph.ts");
		const drawable = (await buildGraph()).getGraph();
		const edges = edgeList(drawable);
		// Same idiom as SIO-1026: the KG-tail nodes are still registered (and the
		// recordRootCause->recordBindings->followUp chain still exists as structure),
		// but aggregateMitigation edges DIRECTLY to followUp, so the chain is
		// unreachable. Assert the bypass edge is present.
		expect(edges).toContain("aggregateMitigation->followUp");
		expect(edges).not.toContain("aggregateMitigation->recordRootCause");
	});
});
