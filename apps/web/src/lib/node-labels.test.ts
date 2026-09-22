// apps/web/src/lib/node-labels.test.ts

import { describe, expect, test } from "bun:test";
import { buildLandingZoneGraph } from "@devops-agent/agent";
import { ALL_NODE_LABELS, LANDING_ZONE_NODES, nodeLabelFor } from "./node-labels.ts";

describe("Landing Zone graph labels", () => {
	test("labels every node in the compiled graph", async () => {
		const graph = await buildLandingZoneGraph({ checkpointerType: "memory" });
		const drawable = await graph.getGraphAsync();
		const nodeIds = Object.keys(drawable.nodes).filter((id) => id !== "__start__" && id !== "__end__");

		expect(LANDING_ZONE_NODES.map((node) => node.id).sort()).toEqual([...nodeIds].sort());
		for (const nodeId of nodeIds) {
			expect(ALL_NODE_LABELS[nodeId]?.activeLabel.length).toBeGreaterThan(0);
			expect(ALL_NODE_LABELS[nodeId]?.completeLabel.length).toBeGreaterThan(0);
		}
	});

	test("scopes shared bootstrap and teardown labels to the active agent", () => {
		expect(nodeLabelFor("bootstrap")?.completeLabel).toBe("Bootstrapped");
		expect(nodeLabelFor("teardown", "elastic-iac")?.completeLabel).toBe("Finished");
		expect(nodeLabelFor("bootstrap", "landing-zone-terraform")?.completeLabel).toBe("Session started");
		expect(nodeLabelFor("teardown", "landing-zone-terraform")?.completeLabel).toBe("Session finished");
	});
});
