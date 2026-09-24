// packages/agent/src/landing-zone/topology-node.ts

import type { LandingZoneTopologyEvent, TopologyDiagramView } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { getToolsForDataSource } from "../mcp-bridge.ts";
import { extractTextSegmentsFromContent } from "../message-utils.ts";
import type { LandingZoneStateType } from "./state.ts";
import { parseReconciledTopologyToolPage, projectLandingZoneTopology } from "./topology-projection.ts";
import type { ReconciledTopology } from "./topology-reconcile.ts";

export interface LandingZoneTopologyTool {
	name: string;
	invoke(input: Record<string, unknown>, config?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface LandingZoneTopologyNodeOptions {
	tools?: LandingZoneTopologyTool[];
	pageSize?: number;
	maxPages?: number;
}

const TOPOLOGY_REQUEST_PATTERN = /\b(topology|network map|dns|hostname|resolution|route path|network path|diagram)\b/i;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 20;

function messageText(messages: BaseMessage[]): string {
	return messages
		.filter((message) => message._getType() === "human")
		.flatMap((message) => extractTextSegmentsFromContent(message.content))
		.join("\n");
}

function requestedView(text: string): TopologyDiagramView {
	if (/\b(route|reachability|network path)\b/i.test(text)) return "path";
	if (/\b(dns|hostname|resolution)\b/i.test(text)) return "dns";
	return "network";
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
	return text.match(pattern)?.[0];
}

function requestedTargets(state: LandingZoneStateType): string[] {
	const authorized = new Set(state.authorizedAccountScope);
	return [...new Set(state.accountScope.filter((accountId) => authorized.has(accountId)))].sort();
}

export async function projectLandingZoneTopologyNode(
	state: LandingZoneStateType,
	options: LandingZoneTopologyNodeOptions = {},
): Promise<Partial<LandingZoneStateType>> {
	const text = messageText(state.messages);
	if (!TOPOLOGY_REQUEST_PATTERN.test(text)) return { landingZoneTopology: null };
	const accountIds = requestedTargets(state);
	if (accountIds.length === 0) return { landingZoneTopology: null };
	const vpcId = firstMatch(text, /\bvpc-[a-z0-9-]+\b/i);
	const hostname = /\b(dns|hostname|resolution)\b/i.test(text)
		? firstMatch(text, /\b[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}\b/i)
		: undefined;
	const tool = (options.tools ?? getToolsForDataSource("knowledge-graph")).find(
		(candidate) => candidate.name === "kg_run_cypher",
	);
	if (!tool) return { landingZoneTopology: null };
	try {
		const pageSize = Math.min(DEFAULT_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
		const maxPages = Math.min(DEFAULT_MAX_PAGES, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
		const reconciled: ReconciledTopology = { entities: [], relationships: [] };
		let queryTruncated = false;
		for (let page = 0; page < maxPages; page += 1) {
			const result = await tool.invoke({
				cypher:
					"MATCH (f:TopologyFact) WHERE f.validTo = '' AND f.accountId IN $accountIds RETURN f.payload AS payload ORDER BY f.id SKIP $offset LIMIT $pageSize",
				params: { accountIds, offset: page * pageSize, pageSize },
			});
			const parsed = parseReconciledTopologyToolPage(result);
			reconciled.entities.push(...parsed.topology.entities);
			reconciled.relationships.push(...parsed.topology.relationships);
			if (parsed.rowCount < pageSize) break;
			if (page === maxPages - 1) {
				const probe = await tool.invoke({
					cypher:
						"MATCH (f:TopologyFact) WHERE f.validTo = '' AND f.accountId IN $accountIds RETURN f.payload AS payload ORDER BY f.id SKIP $offset LIMIT $pageSize",
					params: { accountIds, offset: maxPages * pageSize, pageSize: 1 },
				});
				queryTruncated = parseReconciledTopologyToolPage(probe).rowCount > 0;
			}
		}
		if (reconciled.entities.length === 0) return { landingZoneTopology: null };
		const view = requestedView(text);
		const projected = projectLandingZoneTopology(reconciled, {
			view,
			...(accountIds.length === 1 && { accountId: accountIds[0] }),
			...(vpcId && { vpcId }),
			...(hostname && { hostname }),
		});
		const topology = queryTruncated ? { ...projected, truncated: true } : projected;
		if (topology.nodes.length === 0) return { landingZoneTopology: null };
		const event: LandingZoneTopologyEvent = { type: "landing_zone_topology", view, topology };
		return { landingZoneTopology: event };
	} catch {
		return { landingZoneTopology: null };
	}
}
