// agent/src/application-topology-kg.ts
// SIO-1457: pure mapper from this turn's ApplicationTopology to the KG writer's
// TopologyEdgeRecord shape (the network-kg.ts derive/render split). Only edges
// OBSERVED this turn are derived -- priorKnowledge overlay edges came FROM the KG
// and writing them back could reset topology-job/orbit-name-match provenance.
// Dependency nodes (dep:) never become DEPENDS_ON rows: that table is
// Service-to-Service, and "postgresql" is not a Service.

import type { TopologyEdgeRecord } from "@devops-agent/knowledge-graph";
import type { ApplicationTopology } from "@devops-agent/shared";

// Bounds the per-turn write volume (an estate-wide APM aggregation can observe
// far more pairs than one incident needs persisted).
export const MAX_EDGES_PER_KIND = 50;

export interface ApplicationTopologyRecord {
	dependsOn: TopologyEdgeRecord[];
	consumesFrom: TopologyEdgeRecord[];
}

function stripPrefix(id: string, prefix: string): string | undefined {
	return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

export function deriveApplicationTopology(
	topology: ApplicationTopology | undefined,
): ApplicationTopologyRecord | undefined {
	if (!topology) return undefined;
	const dependsOn: TopologyEdgeRecord[] = [];
	const consumesFrom: TopologyEdgeRecord[] = [];
	for (const edge of topology.edges) {
		if (edge.priorKnowledge) continue;
		if (edge.kind === "calls" && dependsOn.length < MAX_EDGES_PER_KIND) {
			const from = stripPrefix(edge.from, "svc:");
			const to = stripPrefix(edge.to, "svc:");
			if (from && to && from !== to) dependsOn.push({ kind: "depends-on", from, to });
		} else if (edge.kind === "consumes" && consumesFrom.length < MAX_EDGES_PER_KIND) {
			const from = stripPrefix(edge.from, "cg:");
			const to = stripPrefix(edge.to, "topic:");
			if (from && to) consumesFrom.push({ kind: "consumes-from", from, to });
		}
	}
	if (dependsOn.length === 0 && consumesFrom.length === 0) return undefined;
	return { dependsOn, consumesFrom };
}
