// apps/web/src/lib/server/topology.ts

// A conditional edge registered WITHOUT a path map (it cannot carry one:
// LangGraph compile() validation would then flag the deliberately-unwired
// gated KG nodes as unreachable, per the SIO-640 edge-gate idiom) makes the
// drawable fan the source out to every node in the graph. Replace that
// everything-fan with the router's real dispatch target(s) so the chart stays
// honest. Keep this in sync with the router implementation it names.
const UNKNOWN_ROUTER_TARGETS: Record<string, string[]> = {
	// supervise() only ever dispatches Send("queryDataSource", ...) --
	// packages/agent/src/supervisor.ts.
	detectTopicShift: ["queryDataSource"],
};

export interface DrawableEdge {
	source: string;
	target: string;
	conditional: boolean;
}

// Detect the everything-fan signature (conditional edges from one source to
// every other node) and swap it for the declared real targets. Sources not in
// the override map are left untouched.
export function normalizeEdges(edges: DrawableEdge[], nodeCount: number): DrawableEdge[] {
	const conditionalBySource = new Map<string, number>();
	for (const edge of edges) {
		if (edge.conditional) {
			conditionalBySource.set(edge.source, (conditionalBySource.get(edge.source) ?? 0) + 1);
		}
	}
	const result: DrawableEdge[] = [];
	for (const edge of edges) {
		const overrides = UNKNOWN_ROUTER_TARGETS[edge.source];
		// The fan reaches every node except the source itself and __start__.
		const isEverythingFan = edge.conditional && (conditionalBySource.get(edge.source) ?? 0) >= nodeCount - 2;
		if (overrides && isEverythingFan) {
			if (overrides.includes(edge.target)) result.push(edge);
			continue;
		}
		result.push(edge);
	}
	return result;
}

// SIO-1641: node ids whose on_chain_start/on_chain_end the SSE pump forwards as
// node_start/node_end. Derived from the compiled graph's own drawable (the same
// list /api/agent/topology draws) so the emitting set can never drift from
// graph.ts the way the old hand-maintained PIPELINE_NODES did. LangGraph's
// synthetic entry/exit pseudo-nodes are excluded: the panel draws START/END
// itself from run state.
export function pipelineNodeNames(drawableNodes: readonly string[]): ReadonlySet<string> {
	return new Set(drawableNodes.filter((n) => n !== "__start__" && n !== "__end__"));
}
