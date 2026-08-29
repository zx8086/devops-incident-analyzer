// apps/web/src/lib/graph-layout.ts
//
// SIO-1572: pure layered layout for the live graph triage panel. The topology
// comes from /api/agent/topology (the compiled LangGraph's own drawable), so
// the picture is provably the graph the engine runs -- never hand-edit a
// workflow shape here. Vertical flow: START at the top, each node one row
// below its furthest predecessor. Small graphs only (~31 nodes) -- no library.

export const START_NODE = "__start__";
export const END_NODE = "__end__";

export interface TopologyEdge {
	source: string;
	target: string;
	conditional: boolean;
}

export interface Topology {
	nodes: string[];
	edges: TopologyEdge[];
}

export interface LaidOutNode {
	id: string;
	layer: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LaidOutEdge {
	source: string;
	target: string;
	conditional: boolean;
	// A back/lateral edge (target layer <= source layer, e.g. align ->
	// queryDataSource retry). Routed around the right side of the chart and
	// never marked "taken" by the live view -- completion order cannot prove a
	// retry actually happened.
	back: boolean;
	path: string;
}

export interface GraphLayout {
	nodes: LaidOutNode[];
	edges: LaidOutEdge[];
	width: number;
	height: number;
}

// Geometry shared by layout and the SVG renderer.
const NODE_W = 180;
const NODE_H = 40;
const PILL_W = 84;
const PILL_H = 28;
const GAP_X = 18;
const GAP_Y = 34;
const PAD = 16;
// How far a back edge bows out past the right edge of the chart.
const BACK_EDGE_BOW = 46;

// Longest-path layering via DFS from START, skipping back edges (an edge whose
// target is on the current DFS stack). Cycles like queryDataSource <-> align
// would otherwise inflate layers on every relaxation pass. Nodes unreachable
// from START (e.g. the KG lane when KNOWLEDGE_GRAPH_ENABLED=false leaves
// recordEntities with no incoming edge) are dropped: the panel shows what can
// actually run, not registered-but-unwired islands.
function computeLayers(topology: Topology): Map<string, number> {
	const adjacency = new Map<string, string[]>();
	for (const edge of topology.edges) {
		const targets = adjacency.get(edge.source) ?? [];
		targets.push(edge.target);
		adjacency.set(edge.source, targets);
	}
	const layers = new Map<string, number>([[START_NODE, 0]]);
	const onStack = new Set<string>();
	const visit = (node: string) => {
		onStack.add(node);
		const fromLayer = layers.get(node) ?? 0;
		for (const target of adjacency.get(node) ?? []) {
			if (onStack.has(target)) continue;
			if ((layers.get(target) ?? -1) < fromLayer + 1) {
				layers.set(target, fromLayer + 1);
				visit(target);
			}
		}
		onStack.delete(node);
	};
	visit(START_NODE);
	// END sits on its own final row even when a short lane (e.g. the HIL
	// learning lane's early exits) reaches it sooner.
	if (layers.has(END_NODE)) {
		const deepest = Math.max(...[...layers.entries()].filter(([id]) => id !== END_NODE).map(([, l]) => l));
		layers.set(END_NODE, deepest + 1);
	}
	return layers;
}

function nodeSize(id: string): { width: number; height: number } {
	return id === START_NODE || id === END_NODE ? { width: PILL_W, height: PILL_H } : { width: NODE_W, height: NODE_H };
}

export function computeLayout(topology: Topology): GraphLayout {
	const layers = computeLayers(topology);

	// Rows keep the topology's node order for deterministic layouts.
	const rows: string[][] = [];
	for (const id of topology.nodes) {
		const layer = layers.get(id);
		if (layer === undefined) continue;
		const row = rows[layer] ?? [];
		row.push(id);
		rows[layer] = row;
	}
	const presentRows = rows.filter((row) => row && row.length > 0);

	const rowWidth = (row: string[]) => row.reduce((sum, id) => sum + nodeSize(id).width, 0) + (row.length - 1) * GAP_X;
	const contentWidth = Math.max(...presentRows.map(rowWidth), NODE_W);
	const width = contentWidth + PAD * 2 + BACK_EDGE_BOW;

	const positions = new Map<string, LaidOutNode>();
	let y = PAD;
	presentRows.forEach((row) => {
		let x = PAD + (contentWidth - rowWidth(row)) / 2;
		const rowHeight = Math.max(...row.map((id) => nodeSize(id).height));
		for (const id of row) {
			const { width: w, height: h } = nodeSize(id);
			positions.set(id, {
				id,
				layer: layers.get(id) ?? 0,
				x,
				y: y + (rowHeight - h) / 2,
				width: w,
				height: h,
			});
			x += w + GAP_X;
		}
		y += rowHeight + GAP_Y;
	});
	const height = y - GAP_Y + PAD;

	// Dedupe parallel edges (a conditional path map can repeat a plain edge).
	const seen = new Set<string>();
	const edges: LaidOutEdge[] = [];
	for (const edge of topology.edges) {
		const key = `${edge.source}->${edge.target}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const source = positions.get(edge.source);
		const target = positions.get(edge.target);
		if (!source || !target) continue;
		const back = target.layer <= source.layer;
		edges.push({
			source: edge.source,
			target: edge.target,
			conditional: edge.conditional,
			back,
			path: back ? backEdgePath(source, target, width) : forwardEdgePath(source, target),
		});
	}

	return { nodes: [...positions.values()], edges, width, height };
}

// Bottom-center of the source curving to top-center of the target.
function forwardEdgePath(source: LaidOutNode, target: LaidOutNode): string {
	const x1 = source.x + source.width / 2;
	const y1 = source.y + source.height;
	const x2 = target.x + target.width / 2;
	const y2 = target.y;
	const midY = (y1 + y2) / 2;
	return `M${x1} ${y1} C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
}

// Right side of the source bowing around the chart edge to the right side of
// the target (used for retry/back edges so they never cross the forward flow).
function backEdgePath(source: LaidOutNode, target: LaidOutNode, chartWidth: number): string {
	const x1 = source.x + source.width;
	const y1 = source.y + source.height / 2;
	const x2 = target.x + target.width;
	const y2 = target.y + target.height / 2;
	const bowX = chartWidth - PAD / 2;
	return `M${x1} ${y1} C${bowX} ${y1} ${bowX} ${y2} ${x2} ${y2}`;
}
