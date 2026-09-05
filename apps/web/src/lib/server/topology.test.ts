// apps/web/src/lib/server/topology.test.ts
import { describe, expect, test } from "bun:test";
import { type DrawableEdge, normalizeEdges, pipelineNodeNames } from "./topology";

function fanOut(source: string, targets: string[]): DrawableEdge[] {
	return targets.map((target) => ({ source, target, conditional: true }));
}

describe("normalizeEdges", () => {
	test("collapses the detectTopicShift everything-fan to queryDataSource", () => {
		// A map-less conditional edge fans out to every node except __start__ and
		// the source itself.
		const nodes = ["__start__", "detectTopicShift", "queryDataSource", "align", "aggregate", "__end__"];
		const edges: DrawableEdge[] = [
			{ source: "__start__", target: "detectTopicShift", conditional: false },
			...fanOut(
				"detectTopicShift",
				nodes.filter((n) => n !== "__start__" && n !== "detectTopicShift"),
			),
			{ source: "queryDataSource", target: "align", conditional: false },
		];
		const normalized = normalizeEdges(edges, nodes.length);
		const fromShift = normalized.filter((e) => e.source === "detectTopicShift");
		expect(fromShift).toEqual([{ source: "detectTopicShift", target: "queryDataSource", conditional: true }]);
		// Unrelated edges pass through untouched.
		expect(normalized.some((e) => e.source === "__start__")).toBe(true);
		expect(normalized.some((e) => e.source === "queryDataSource")).toBe(true);
	});

	test("leaves a real (path-mapped) conditional fan from detectTopicShift alone", () => {
		// Only two conditional targets out of many nodes: not the everything-fan
		// signature, so no override applies even for a listed source.
		const edges: DrawableEdge[] = [
			{ source: "detectTopicShift", target: "queryDataSource", conditional: true },
			{ source: "detectTopicShift", target: "align", conditional: true },
		];
		expect(normalizeEdges(edges, 10)).toEqual(edges);
	});

	test("leaves everything-fans from sources without an override untouched", () => {
		const edges = fanOut("someRouter", ["a", "b", "c"]);
		expect(normalizeEdges(edges, 5)).toEqual(edges);
	});
});

// SIO-1641: the SSE pump's node_start/node_end allowlist is derived from the compiled
// graph's drawable instead of a hand-maintained list (which had drifted: nine
// incident nodes and eleven IaC nodes never lit). Only LangGraph's synthetic
// entry/exit pseudo-nodes are excluded -- the panel draws START/END itself.
describe("pipelineNodeNames", () => {
	test("keeps every registered node and strips __start__/__end__", () => {
		const names = pipelineNodeNames(["__start__", "classify", "selectRunbooks", "recordBindings", "__end__"]);
		expect([...names].sort()).toEqual(["classify", "recordBindings", "selectRunbooks"]);
	});

	test("returns an empty set for an empty drawable", () => {
		expect(pipelineNodeNames([]).size).toBe(0);
	});
});
