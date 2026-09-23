// apps/web/src/lib/server/archify/to-archify.ts
import type { ApplicationTopology, NetworkTopology } from "@devops-agent/shared";
import { UNHEALTHY_ERROR_RATE } from "../../app-chart.ts";
import { collapseDnsRecords, focusGraph } from "./focus.ts";

// SIO-1876: deterministic topology -> Archify architecture JSON. Archify has no auto-layout, so
// this places components on its grid: one column band per node kind in flow order, and one row
// block per group (subnet, else VPC, else ungrouped). A group's components stay inside its own
// row block, so a boundary's bounding box never takes in another group's components.
// ponytail: banded grid, not a real layered layout. Swap in computeLayers
// (apps/web/src/lib/graph-layout.ts) if the bands read badly on wide topologies.

type ComponentType = "frontend" | "backend" | "database" | "cloud" | "security" | "messagebus" | "external";

export type ArchifyComponent = {
	id: string;
	type: ComponentType;
	label: string;
	sublabel?: string;
	tag?: string;
	size: [number, number];
	row: number;
	col: number;
};
export type ArchifyConnection = {
	id: string;
	from: string;
	to: string;
	label?: string;
	variant?: "default" | "emphasis" | "dashed";
	fromSide?: "left" | "right" | "top" | "bottom";
	toSide?: "left" | "right" | "top" | "bottom";
	via?: [number, number][];
	labelAt?: [number, number];
};
export type ArchifyBoundary = { kind: "region" | "security-group"; label: string; wraps: string[] };
export type ArchifyArchitecture = {
	schema_version: 1;
	diagram_type: "architecture";
	meta: { title: string; subtitle?: string; visual_preset: "signal-flow" };
	layout: {
		mode: "grid";
		origin: [number, number];
		cols: number;
		cellW: number;
		cellH: number;
		gapX: number;
		gapY: number;
	};
	components: ArchifyComponent[];
	boundaries?: ArchifyBoundary[];
	connections: ArchifyConnection[];
};

type Placeable = Omit<ArchifyComponent, "row" | "col" | "size"> & { band: number; group: string };

// ~7px per char at the renderer's label size; keeps labels inside a CELL_W box.
const MAX_LABEL = 22;
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}...` : s);

// Archify ids must match ^[a-zA-Z][a-zA-Z0-9_-]*$; topology ids are ARNs and "kind:name:port" keys.
function makeIdMap(ids: Iterable<string>): Map<string, string> {
	const map = new Map<string, string>();
	const used = new Set<string>();
	for (const id of ids) {
		const base = `n_${id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`.slice(0, 60);
		let safe = base;
		for (let i = 2; used.has(safe); i++) safe = `${base}_${i}`;
		used.add(safe);
		map.set(id, safe);
	}
	return map;
}

// Groups are laid out in first-seen order; within a group each band fills downward, so the
// block height is the tallest band in it.
function place(items: Placeable[], bandCount: number): ArchifyComponent[] {
	const groups = new Map<string, Placeable[]>();
	for (const item of items) {
		const list = groups.get(item.group) ?? [];
		list.push(item);
		groups.set(item.group, list);
	}
	const out: ArchifyComponent[] = [];
	let rowBase = 0;
	for (const members of groups.values()) {
		const fill = new Array<number>(bandCount).fill(0);
		for (const { band, group: _g, ...component } of members) {
			out.push({ ...component, size: [CELL_W, CELL_H], row: rowBase + (fill[band] ?? 0), col: band });
			fill[band] = (fill[band] ?? 0) + 1;
		}
		rowBase += Math.max(...fill);
	}
	return out;
}

const CELL_W = 190;
const CELL_H = 64;
const GRID = {
	mode: "grid",
	origin: [40, 80] as [number, number],
	cellW: CELL_W,
	cellH: CELL_H,
	gapX: 130,
	gapY: 44,
} as const;

const STEP_X = CELL_W + GRID.gapX;
const STEP_Y = CELL_H + GRID.gapY;
const cellX = (col: number) => GRID.origin[0] + col * STEP_X;
const cellMidY = (row: number) => GRID.origin[1] + row * STEP_Y + CELL_H / 2;

// Archify rejects any edge drawn through an unrelated component, and its auto-router only goes
// around them between adjacent columns. Anything else is routed through the gutters, which hold
// no components: same-column edges down the right-hand gutter, column-skipping edges along the
// gap row under the source. Labels on these edges are dropped, since a gutter is narrower than a
// label and Archify rejects labels over components. ponytail: routed edges can share a gutter
// lane; give each one its own lane offset if Archify's corridor checks start rejecting them.
type Cell = { row: number; col: number };
function routeFields(a: Cell, b: Cell, label: string | undefined): Partial<ArchifyConnection> {
	const rightGutter = (col: number) => cellX(col) + CELL_W + GRID.gapX / 2;
	// The auto-router turns inside the gutter between adjacent columns, so a label pinned to the
	// gutter centre sits on the edge and never over a component (gapX is wider than a clipped label).
	if (b.col === a.col + 1) {
		return label ? { label, labelAt: [rightGutter(a.col), (cellMidY(a.row) + cellMidY(b.row)) / 2] } : {};
	}
	if (b.col === a.col) {
		const x = rightGutter(a.col);
		return {
			fromSide: "right",
			toSide: "right",
			via: [
				[x, cellMidY(a.row)],
				[x, cellMidY(b.row)],
			],
		};
	}
	const forward = b.col > a.col;
	const gapY = GRID.origin[1] + (a.row + 1) * STEP_Y - GRID.gapY / 2;
	const xa = forward ? rightGutter(a.col) : cellX(a.col) - GRID.gapX / 2;
	const xb = forward ? cellX(b.col) - GRID.gapX / 2 : rightGutter(b.col);
	return {
		fromSide: forward ? "right" : "left",
		toSide: forward ? "left" : "right",
		via: [
			[xa, cellMidY(a.row)],
			[xa, gapY],
			[xb, gapY],
			[xb, cellMidY(b.row)],
		],
	};
}

function usedBands(components: ArchifyComponent[]): number {
	return Math.max(1, ...components.map((c) => c.col + 1));
}

const NETWORK_BANDS = {
	dnsRecord: 0,
	serviceEndpoint: 0,
	loadBalancer: 1,
	targetGroup: 2,
	// attached-to runs eni -> workload, so ENIs sit in the band before workloads.
	eni: 2,
	workload: 3,
} as const;
const NETWORK_TYPES: Record<keyof typeof NETWORK_BANDS, ComponentType> = {
	dnsRecord: "external",
	serviceEndpoint: "external",
	loadBalancer: "backend",
	targetGroup: "backend",
	workload: "backend",
	eni: "backend",
};

// Drawn components per diagram; see focus.ts for why the Diagram tab is a focused view.
export const DIAGRAM_NODE_BUDGET = 16;

export function networkToArchify(full: NetworkTopology): ArchifyArchitecture {
	const collapsed = collapseDnsRecords(full);
	const focused = focusGraph(collapsed.nodes, collapsed.edges, DIAGRAM_NODE_BUDGET);
	const t = { ...collapsed, nodes: focused.nodes, edges: focused.edges };
	const subnetOf = new Map<string, string>();
	const vpcOf = new Map<string, string>();
	for (const e of t.edges) {
		if (e.kind === "in-subnet" && !subnetOf.has(e.from)) subnetOf.set(e.from, e.to);
		if (e.kind === "in-vpc" && !vpcOf.has(e.from)) vpcOf.set(e.from, e.to);
	}
	const vpcFor = (id: string) => {
		const subnet = subnetOf.get(id);
		return (subnet && vpcOf.get(subnet)) ?? vpcOf.get(id);
	};

	const drawn = t.nodes.filter((n) => n.kind !== "vpc" && n.kind !== "subnet");
	const ids = makeIdMap(drawn.map((n) => n.id));
	// Sort so each VPC's subnets are adjacent row blocks, keeping the VPC boundary contiguous.
	const groupKey = (id: string) => `${vpcFor(id) ?? "~"}|${subnetOf.get(id) ?? "~"}`;
	const ordered = [...drawn].sort((a, b) => groupKey(a.id).localeCompare(groupKey(b.id)));

	const items: Placeable[] = ordered.map((n) => {
		const kind = n.kind as keyof typeof NETWORK_BANDS;
		const healthTag = n.health ? `${n.health.healthy}/${n.health.total} healthy` : undefined;
		const sublabel = n.endpoint
			? `${n.endpoint.host}${n.endpoint.port ? `:${n.endpoint.port}` : ""}`
			: (n.privateIps?.[0] ?? n.recordType ?? n.lbType);
		return {
			id: ids.get(n.id) ?? n.id,
			type: NETWORK_TYPES[kind],
			label: clip(n.name ?? n.id),
			...(sublabel ? { sublabel: clip(sublabel) } : {}),
			...(healthTag ? { tag: healthTag } : {}),
			band: NETWORK_BANDS[kind],
			group: groupKey(n.id),
		};
	});
	const components = place(items, 4);
	const cellOf = new Map(components.map((c) => [c.id, c]));

	const boundaries: ArchifyBoundary[] = [];
	const wrapsFor = (pred: (id: string) => boolean) => drawn.filter((n) => pred(n.id)).map((n) => ids.get(n.id) ?? n.id);
	for (const node of t.nodes) {
		if (node.kind !== "vpc" && node.kind !== "subnet") continue;
		const wraps =
			node.kind === "vpc" ? wrapsFor((id) => vpcFor(id) === node.id) : wrapsFor((id) => subnetOf.get(id) === node.id);
		if (wraps.length === 0) continue;
		const label = clip([node.name ?? node.id, node.cidr].filter(Boolean).join(" "));
		boundaries.push({ kind: node.kind === "vpc" ? "region" : "security-group", label, wraps });
	}

	const connections: ArchifyConnection[] = [];
	for (const e of t.edges) {
		const from = ids.get(e.from);
		const to = ids.get(e.to);
		if (!from || !to) continue; // vpc/subnet ends became boundaries
		const a = cellOf.get(from);
		const b = cellOf.get(to);
		if (!a || !b) continue;
		connections.push({
			id: `c${connections.length}`,
			from,
			to,
			...routeFields(a, b, e.detail ? clip(e.detail) : undefined),
			...(e.derived ? { variant: "dashed" as const } : {}),
		});
	}

	return {
		schema_version: 1,
		diagram_type: "architecture",
		meta: { title: "Network map", subtitle: subtitleFor(full, focused), visual_preset: "signal-flow" },
		layout: { ...GRID, cols: usedBands(components) },
		components,
		...(boundaries.length ? { boundaries } : {}),
		connections,
	};
}

// consumes runs consumerGroup -> kafkaTopic and calls/runs-on run service -> *, so every edge points right.
const APP_BANDS = { consumerGroup: 0, service: 0, kafkaTopic: 1, dependency: 1, awsResource: 2 } as const;
const APP_TYPES: Record<keyof typeof APP_BANDS, ComponentType> = {
	service: "backend",
	dependency: "external",
	kafkaTopic: "messagebus",
	consumerGroup: "messagebus",
	awsResource: "cloud",
};

export function applicationToArchify(full: ApplicationTopology): ArchifyArchitecture {
	const focused = focusGraph(full.nodes, full.edges, DIAGRAM_NODE_BUDGET);
	const t = { ...full, nodes: focused.nodes, edges: focused.edges };
	const ids = makeIdMap(t.nodes.map((n) => n.id));
	const items: Placeable[] = t.nodes.map((n) => {
		const unhealthy = n.errorRate !== undefined && n.errorRate >= UNHEALTHY_ERROR_RATE;
		const sublabel = n.avgDurationMs !== undefined ? `avg ${Math.round(n.avgDurationMs)}ms` : undefined;
		return {
			id: ids.get(n.id) ?? n.id,
			type: APP_TYPES[n.kind],
			label: clip(n.name ?? n.id),
			...(sublabel ? { sublabel } : {}),
			...(unhealthy && n.errorRate !== undefined ? { tag: `err ${(n.errorRate * 100).toFixed(1)}%` } : {}),
			band: APP_BANDS[n.kind],
			group: "all",
		};
	});
	const components = place(items, 3);
	const cellOf = new Map(components.map((c) => [c.id, c]));

	const connections: ArchifyConnection[] = [];
	for (const e of t.edges) {
		const from = ids.get(e.from);
		const to = ids.get(e.to);
		if (!from || !to) continue;
		const a = cellOf.get(from);
		const b = cellOf.get(to);
		if (!a || !b) continue;
		connections.push({
			id: `c${connections.length}`,
			from,
			to,
			...routeFields(a, b, e.detail ? clip(e.detail) : undefined),
			...(e.priorKnowledge ? { variant: "dashed" as const } : {}),
		});
	}

	return {
		schema_version: 1,
		diagram_type: "architecture",
		meta: { title: "Application map", subtitle: subtitleFor(full, focused), visual_preset: "signal-flow" },
		layout: { ...GRID, cols: usedBands(components) },
		components,
		connections,
	};
}

// Says when the diagram is a subset, so nobody reads a focused view as the whole map.
function subtitleFor(
	t: { sources: string[]; truncated?: boolean },
	focused: { nodes: { kind: string }[]; total: number },
): string {
	const shown = focused.nodes.filter((n) => n.kind !== "vpc" && n.kind !== "subnet").length;
	const scope =
		shown < focused.total
			? `${shown} of ${focused.total} nodes around the focus services and busiest hubs; all on the Map tab`
			: `${shown} nodes`;
	return `${scope} | Sources: ${t.sources.join(", ") || "none"}${t.truncated ? " (truncated)" : ""}`;
}
