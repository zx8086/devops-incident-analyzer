// agent/src/iac/graph.test.ts
import { describe, expect, test } from "bun:test";
import { buildIacGraph } from "./graph.ts";

// Smoke test: the IaC graph compiles (with a memory checkpointer) and exposes the
// runnable surface the web server drives. Executing nodes needs Bedrock + the
// unified MCP server, so node behavior is covered by guards.test.ts and integration.
describe("buildIacGraph", () => {
	test("compiles and exposes streamEvents + getState", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		expect(typeof graph.streamEvents).toBe("function");
		expect(typeof graph.getState).toBe("function");
	});

	test("graph contains the human-review gate and the maker nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("reviewGate");
		expect(nodeNames).toContain("guard");
		expect(nodeNames).toContain("openMr");
		expect(nodeNames).toContain("teardown");
	});

	// SIO-870: read-vs-write branch off the classifier.
	test("graph contains the intent classifier and the info-answer node", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("classifyIacIntent");
		expect(nodeNames).toContain("answerInfo");
	});

	// SIO-875: post-MR pipeline watch node.
	test("graph contains the watchPipeline node", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("watchPipeline");
	});

	// SIO-882: drift detection + per-stack reconcile loop nodes.
	test("graph contains the drift detection + reconcile loop nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("detectDrift");
		expect(nodeNames).toContain("reconcileGate");
		expect(nodeNames).toContain("reconcileStack");
		expect(nodeNames).toContain("advanceDrift");
	});
});
