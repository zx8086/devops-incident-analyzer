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

	// SIO-990: the correction/amend lane node (gitops-amend -> amendChange -> readClusterState).
	// Its presence confirms the new node registers and the new conditional edges compile.
	test("graph contains the amendChange node", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("amendChange");
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

	// SIO-1038: the pre-fan-out prompt-capture node (registered always; edge-gated).
	test("graph contains the recordIacPrompt node", async () => {
		const graph = await buildIacGraph({ checkpointerType: "memory" });
		const nodeNames = Object.keys(graph.getGraph().nodes);
		expect(nodeNames).toContain("recordIacPrompt");
	});
});

import { END } from "@langchain/langgraph";
import { routeAfterDraft } from "./graph.ts";
import type { IacStateType } from "./state.ts";

// SIO-1196: draftChange exits. Terminal block/no-op -> END; a version live-drift (repo already
// at target, live behind) -> the drift lane's explainDrift; else the review gate.
describe("routeAfterDraft (SIO-1196)", () => {
	const s = (over: Partial<IacStateType>): IacStateType => over as unknown as IacStateType;
	const drift = { cluster: "us-cld", targetVersion: "9.4.4", liveVersion: "9.4.3" };

	test("blockedReason and noopReason end the turn", () => {
		expect(routeAfterDraft(s({ blockedReason: "nope" }))).toBe(END);
		expect(routeAfterDraft(s({ noopReason: "already there" }))).toBe(END);
	});

	test("versionDrift routes into the drift lane at explainDrift", () => {
		expect(routeAfterDraft(s({ versionDrift: drift }))).toBe("explainDrift");
	});

	test("default routes to the review gate", () => {
		expect(routeAfterDraft(s({}))).toBe("reviewPlan");
	});

	test("blockedReason wins over versionDrift -- never enter the lane on a blocked turn", () => {
		expect(routeAfterDraft(s({ blockedReason: "nope", versionDrift: drift }))).toBe(END);
	});
});
