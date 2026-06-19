// agent/src/iac/info-local-tools.test.ts
//
// SIO-967: infoTools() now sources the knowledge-graph query tools from the STANDARD
// MCP surface (the curated kg_* tools served by the in-process knowledge-graph-mcp
// server, via getToolsForDataSource("knowledge-graph")), and keeps search_memory as
// the one LOCAL tool. We stub the MCP bridge so the elastic-iac read subset is empty
// and the knowledge-graph datasource returns a fake kg_* tool -- proving both the MCP
// kg_* tools and the local memory tool are bound. The kg_* query handlers themselves
// are tested in packages/mcp-server-knowledge-graph/src/tools/curated.test.ts.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tool as createTool } from "@langchain/core/tools";
import { z } from "zod";

const fakeKgTool = createTool(async () => "Stacks using the lifecycle module: lifecycle-policies.", {
	name: "kg_stacks_using_module",
	description: "fake kg tool",
	schema: z.object({ module: z.string() }),
});

beforeEach(async () => {
	// elastic-iac read subset -> empty; knowledge-graph datasource -> one kg_* tool.
	// SIO-862: own a COMPLETE mock (spread the real module) so a sibling test reading
	// other mcp-bridge exports (e.g. MCP_SERVER_TO_ROLE in the boot-strict suite) isn't
	// poisoned by this process-global, last-wins mock.module override.
	const real = await import("../mcp-bridge.ts");
	mock.module("../mcp-bridge.ts", () => ({
		...real,
		getToolsForDataSource: (ds: string) => (ds === "knowledge-graph" ? [fakeKgTool] : []),
		getConnectedServers: () => ["elastic-iac-mcp", "knowledge-graph-mcp"],
	}));
});

afterEach(() => {
	mock.restore();
});

describe("infoTools binds the MCP kg_* tools + local memory tool (SIO-967)", () => {
	test("kg_* MCP tools + search_memory are present in the read tool set", async () => {
		const { infoTools } = await import("./nodes.ts");
		const names = infoTools().map((t) => t.name);
		expect(names).toContain("kg_stacks_using_module");
		expect(names).toContain("search_memory");
		// the retired SIO-966 local tool name must be gone
		expect(names).not.toContain("query_knowledge_graph");
	});
});
