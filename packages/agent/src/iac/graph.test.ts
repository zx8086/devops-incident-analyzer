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

	// SIO-882/886: drift detection, the explainer, and the per-stack reconcile loop nodes.
	test("graph contains the drift detection + explainer + reconcile loop nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("detectDrift");
		expect(nodeNames).toContain("explainDrift");
		expect(nodeNames).toContain("reconcileGate");
		expect(nodeNames).toContain("reconcileStack");
		expect(nodeNames).toContain("advanceDrift");
	});

	// SIO-902: synthetics drift detection + push gate + push nodes.
	test("graph contains the synthetics drift detection + push gate + push nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("detectSyntheticsDrift");
		expect(nodeNames).toContain("syntheticsPushGate");
		expect(nodeNames).toContain("pushSynthetics");
	});

	// SIO-913: Fleet agent binary-upgrade sub-flow (preview -> gate -> apply).
	test("graph contains the fleet-upgrade detect + gate + apply nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("detectFleetUpgrade");
		expect(nodeNames).toContain("fleetUpgradeGate");
		expect(nodeNames).toContain("applyFleetUpgrade");
	});

	// SIO-954/SIO-965: knowledge-graph nodes are registered always (reached only when
	// KNOWLEDGE_GRAPH_ENABLED is set via the edge-gate idiom), so they exist on the graph.
	test("graph contains the knowledge-graph read/write/outcome nodes", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("graphEnrichIac");
		expect(nodeNames).toContain("recordIacEntities");
		expect(nodeNames).toContain("recordIacOutcome");
	});
});
