// apps/web/src/lib/server/archify/focus.ts
import type { NetworkTopology } from "@devops-agent/shared";

// SIO-1876: an Archify diagram reads well at roughly 7-15 nodes (the gallery examples are 7-12); a
// live turn's network map runs to 200. The Diagram tab therefore draws the neighbourhood of the
// services under investigation, and the ECharts Map tab keeps the full picture.

type FocusNode = { id: string; kind: string; service?: string };
type FocusEdge = { from: string; to: string; kind: string };

export type Focused<N, E> = { nodes: N[]; edges: E[]; total: number; seeds: string[] };

// Containers (vpc/subnet) are drawn as boundaries, not components, so they do not spend the
// budget; containment edges only decide which boundary a kept node sits in.
const CONTAINER_KINDS = new Set(["vpc", "subnet"]);
const CONTAINMENT_EDGES = new Set(["in-vpc", "in-subnet"]);
// Neighbours a node brings in per round. Without it one ALB with 15 target groups spent the whole
// budget on a single star (live network map); with it the budget spreads over several neighbourhoods.
const FANOUT = 4;

// Expands outward from the nodes linked to a focus service (`service` is set by the builders when a
// node resolves to one), over traffic edges in either direction, until `budget` components are
// kept. The containers of every kept node are kept too, so its boundary still draws.
export function focusGraph<N extends FocusNode, E extends FocusEdge>(
	nodes: N[],
	edges: E[],
	budget: number,
): Focused<N, E> {
	const drawable = nodes.filter((n) => !CONTAINER_KINDS.has(n.kind));
	// A map that already fits is drawn whole: focusing it would only drop nodes that are
	// disconnected from the seeds, which on a small map are still worth seeing.
	if (drawable.length <= budget) {
		return { nodes, edges, total: drawable.length, seeds: drawable.filter((n) => n.service).map((n) => n.id) };
	}
	const flow = edges.filter((e) => !CONTAINMENT_EDGES.has(e.kind));
	const neighbours = new Map<string, string[]>();
	for (const e of flow) {
		neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
		neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
	}

	const drawableIds = new Set(drawable.map((n) => n.id));
	const degree = (id: string) => neighbours.get(id)?.length ?? 0;
	// Array.sort is stable, so degree ties keep builder order and every choice is deterministic.
	const byDegree = (ids: Iterable<string>) => [...ids].sort((x, y) => degree(y) - degree(x));
	const seeds = byDegree(drawable.filter((n) => n.service).map((n) => n.id));
	const hubs = byDegree(drawableIds).filter((id) => degree(id) > 0);

	const kept = new Set<string>();
	const tryKeep = (id: string) => {
		if (kept.size >= budget || kept.has(id) || !drawableIds.has(id)) return false;
		kept.add(id);
		return true;
	};
	// Each round keeps a frontier node together with its direct neighbours (busiest first), so a
	// seed arrives with its context instead of 14 seeds eating the budget as disconnected boxes
	// (seen on a live 38-node application map). The next round expands from those neighbours.
	// When the seeds' neighbourhoods run dry, the busiest remaining hub starts a new one: focus-
	// linked nodes can have no traffic edges at all (6 isolated workloads on a live network map).
	let frontier = seeds;
	while (kept.size < budget) {
		if (frontier.length === 0) {
			const hub = hubs.find((id) => !kept.has(id));
			if (!hub) break;
			frontier = [hub];
		}
		const next: string[] = [];
		for (const id of frontier) {
			tryKeep(id);
			if (!kept.has(id)) continue;
			for (const n of byDegree(neighbours.get(id) ?? []).slice(0, FANOUT)) if (tryKeep(n)) next.push(n);
		}
		frontier = next;
	}

	// Walk containment upward (workload -> subnet -> vpc) from every kept node.
	const parent = new Map<string, string[]>();
	for (const e of edges) if (CONTAINMENT_EDGES.has(e.kind)) parent.set(e.from, [...(parent.get(e.from) ?? []), e.to]);
	const containers = new Set<string>();
	const climb = [...kept];
	while (climb.length > 0) {
		for (const up of parent.get(climb.pop() as string) ?? []) {
			if (!containers.has(up)) {
				containers.add(up);
				climb.push(up);
			}
		}
	}

	const keep = (id: string) => kept.has(id) || containers.has(id);
	return {
		nodes: nodes.filter((n) => keep(n.id)),
		edges: edges.filter((e) => keep(e.from) && keep(e.to)),
		total: drawable.length,
		seeds: seeds.filter((id) => kept.has(id)),
	};
}

// Many DNS records usually alias one load balancer (20 onto a single ALB in a live turn). They
// carry no structure of their own, so each group sharing a target becomes one node naming the
// first record and the count. Records resolving to more than one target are left alone: merging
// them would invent an edge.
export function collapseDnsRecords(t: NetworkTopology): NetworkTopology {
	const targetsOf = new Map<string, Set<string>>();
	for (const e of t.edges) {
		if (e.kind !== "resolves-to") continue;
		const set = targetsOf.get(e.from) ?? new Set<string>();
		set.add(e.to);
		targetsOf.set(e.from, set);
	}
	const groups = new Map<string, NetworkTopology["nodes"]>();
	for (const n of t.nodes) {
		const targets = targetsOf.get(n.id);
		if (n.kind !== "dnsRecord" || targets?.size !== 1) continue;
		const [target] = [...targets];
		if (!target) continue;
		groups.set(target, [...(groups.get(target) ?? []), n]);
	}

	const merged = new Map<string, string>(); // record id -> group node id
	const groupNodes: NetworkTopology["nodes"] = [];
	for (const [target, records] of groups) {
		const [first] = records;
		if (records.length < 2 || !first) continue;
		const id = `dns-group:${target}`;
		for (const r of records) merged.set(r.id, id);
		// recordType renders as the sublabel; it carries the count so the 22-char label keeps the name.
		groupNodes.push({
			id,
			kind: "dnsRecord",
			name: first.name ?? first.id,
			recordType: `+${records.length - 1} more records`,
		});
	}
	if (merged.size === 0) return t;

	const seen = new Set<string>();
	const edges = t.edges
		.map((e) => ({ ...e, from: merged.get(e.from) ?? e.from, to: merged.get(e.to) ?? e.to }))
		.filter((e) => {
			const key = `${e.from}|${e.to}|${e.kind}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	return { ...t, nodes: [...t.nodes.filter((n) => !merged.has(n.id)), ...groupNodes], edges };
}
