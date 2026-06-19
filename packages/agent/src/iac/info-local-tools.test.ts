// agent/src/iac/info-local-tools.test.ts
//
// SIO-966: the local query tools are bound into the read path (answerInfo /
// converseIac) via infoTools(), so the LLM can call them. We assert membership +
// that the bound tool runs end-to-end against a stubbed graph -- deterministic and
// free of the ../llm.ts mock-pollution that a full node-loop test would suffer in
// the combined suite (mock.module is process-global, last-wins).
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";

const prevKg = process.env.KNOWLEDGE_GRAPH_ENABLED;

beforeEach(() => {
	// infoTools() reads the MCP bridge; stub it to no tools so only the two LOCAL
	// tools remain -- proving they are appended independently of the MCP set.
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => [],
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	mock.restore();
	if (prevKg === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prevKg;
	_setGraphStoreForTesting(null);
});

describe("infoTools binds the local query tools (SIO-966)", () => {
	test("query_knowledge_graph + search_memory are present in the read tool set", async () => {
		const { infoTools } = await import("./nodes.ts");
		const names = infoTools().map((t) => t.name);
		expect(names).toContain("query_knowledge_graph");
		expect(names).toContain("search_memory");
	});

	test("the bound query_knowledge_graph tool runs end-to-end against the graph", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		_setGraphStoreForTesting(store);
		const { infoTools } = await import("./nodes.ts");
		const kg = infoTools().find((t) => t.name === "query_knowledge_graph");
		expect(kg).toBeDefined();
		const out = (await kg?.invoke({ query_type: "stacks_using_module", module: "lifecycle" })) as string;
		expect(out).toContain("lifecycle-policies");
	});
});
