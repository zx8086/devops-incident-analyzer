// apps/web/src/lib/graph-layout.test.ts
import { describe, expect, test } from "bun:test";
import { computeLayout, END_NODE, START_NODE, type Topology } from "./graph-layout";

function layerOf(layout: ReturnType<typeof computeLayout>, id: string): number {
	const node = layout.nodes.find((n) => n.id === id);
	if (!node) throw new Error(`node ${id} not laid out`);
	return node.layer;
}

describe("computeLayout", () => {
	test("linear chain gets one layer per node", () => {
		const topology: Topology = {
			nodes: [START_NODE, "a", "b", END_NODE],
			edges: [
				{ source: START_NODE, target: "a", conditional: false },
				{ source: "a", target: "b", conditional: false },
				{ source: "b", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layerOf(layout, START_NODE)).toBe(0);
		expect(layerOf(layout, "a")).toBe(1);
		expect(layerOf(layout, "b")).toBe(2);
		expect(layerOf(layout, END_NODE)).toBe(3);
	});

	test("diamond fan-out shares a layer and rejoins below", () => {
		const topology: Topology = {
			nodes: [START_NODE, "router", "left", "right", "join", END_NODE],
			edges: [
				{ source: START_NODE, target: "router", conditional: false },
				{ source: "router", target: "left", conditional: true },
				{ source: "router", target: "right", conditional: true },
				{ source: "left", target: "join", conditional: false },
				{ source: "right", target: "join", conditional: false },
				{ source: "join", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layerOf(layout, "left")).toBe(2);
		expect(layerOf(layout, "right")).toBe(2);
		expect(layerOf(layout, "join")).toBe(3);
		// Fan-out siblings sit side by side, never overlapping.
		const left = layout.nodes.find((n) => n.id === "left");
		const right = layout.nodes.find((n) => n.id === "right");
		expect(left?.y).toBe(right?.y);
		expect((left?.x ?? 0) + (left?.width ?? 0)).toBeLessThan(right?.x ?? 0);
	});

	test("a node is placed one layer below its FURTHEST predecessor", () => {
		// short: START -> a -> join, long: START -> b -> c -> join.
		const topology: Topology = {
			nodes: [START_NODE, "a", "b", "c", "join", END_NODE],
			edges: [
				{ source: START_NODE, target: "a", conditional: false },
				{ source: START_NODE, target: "b", conditional: false },
				{ source: "b", target: "c", conditional: false },
				{ source: "a", target: "join", conditional: false },
				{ source: "c", target: "join", conditional: false },
				{ source: "join", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layerOf(layout, "join")).toBe(3);
	});

	test("cycle (retry edge) does not inflate layers and is marked back", () => {
		// The align <-> queryDataSource shape from the incident graph.
		const topology: Topology = {
			nodes: [START_NODE, "query", "align", "aggregate", END_NODE],
			edges: [
				{ source: START_NODE, target: "query", conditional: false },
				{ source: "query", target: "align", conditional: false },
				{ source: "align", target: "query", conditional: true },
				{ source: "align", target: "aggregate", conditional: true },
				{ source: "aggregate", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layerOf(layout, "query")).toBe(1);
		expect(layerOf(layout, "align")).toBe(2);
		expect(layerOf(layout, "aggregate")).toBe(3);
		const retry = layout.edges.find((e) => e.source === "align" && e.target === "query");
		expect(retry?.back).toBe(true);
		const forward = layout.edges.find((e) => e.source === "align" && e.target === "aggregate");
		expect(forward?.back).toBe(false);
	});

	test("nodes unreachable from START are dropped (unwired KG island)", () => {
		const topology: Topology = {
			nodes: [START_NODE, "a", "recordEntities", "graphEnrich", END_NODE],
			edges: [
				{ source: START_NODE, target: "a", conditional: false },
				{ source: "a", target: END_NODE, conditional: false },
				// Island: outgoing edges only, no incoming path from START.
				{ source: "recordEntities", target: "graphEnrich", conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layout.nodes.map((n) => n.id).sort()).toEqual([START_NODE, END_NODE, "a"].sort());
		// Edges touching dropped nodes are dropped with them.
		expect(layout.edges.some((e) => e.source === "recordEntities")).toBe(false);
	});

	test("END sits on its own final row even with early exits", () => {
		const topology: Topology = {
			nodes: [START_NODE, "gate", "deep1", "deep2", END_NODE],
			edges: [
				{ source: START_NODE, target: "gate", conditional: false },
				{ source: "gate", target: END_NODE, conditional: true },
				{ source: "gate", target: "deep1", conditional: true },
				{ source: "deep1", target: "deep2", conditional: false },
				{ source: "deep2", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		expect(layerOf(layout, END_NODE)).toBe(layerOf(layout, "deep2") + 1);
	});

	test("duplicate edges are deduped", () => {
		const topology: Topology = {
			nodes: [START_NODE, "a", END_NODE],
			edges: [
				{ source: START_NODE, target: "a", conditional: false },
				{ source: "a", target: END_NODE, conditional: false },
				{ source: "a", target: END_NODE, conditional: true },
			],
		};
		const layout = computeLayout(topology);
		expect(layout.edges.filter((e) => e.source === "a" && e.target === END_NODE)).toHaveLength(1);
	});

	test("every laid-out node fits inside the reported dimensions", () => {
		const topology: Topology = {
			nodes: [START_NODE, "a", "b", "c", END_NODE],
			edges: [
				{ source: START_NODE, target: "a", conditional: false },
				{ source: "a", target: "b", conditional: true },
				{ source: "a", target: "c", conditional: true },
				{ source: "b", target: END_NODE, conditional: false },
				{ source: "c", target: END_NODE, conditional: false },
			],
		};
		const layout = computeLayout(topology);
		for (const node of layout.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(0);
			expect(node.y).toBeGreaterThanOrEqual(0);
			expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
			expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
		}
	});
});
