// apps/web/src/lib/network-chart.ts
// SIO-1204: pure NetworkTopology -> ECharts graph-series option transform. Kept
// separate from the Svelte component (no echarts/DOM imports) so it is unit
// testable; the component passes the result to chart.setOption verbatim. Local
// structural types instead of echarts' Option types keep this module free of
// the echarts dependency and its ambient types.
import type { NetworkTopology, NetworkTopologyNode } from "@devops-agent/shared";

export interface ChartGraphNode {
	id: string;
	name: string;
	category: number;
	symbolSize: number;
	value?: string;
	label?: { show: boolean };
	itemStyle?: { borderColor: string; borderWidth: number };
	tooltip?: { formatter: string };
}

export interface ChartGraphLink {
	source: string;
	target: string;
	lineStyle?: { type: "dashed" };
	label?: { show: boolean; formatter: string; fontSize: number };
}

export interface ChartCategory {
	name: string;
	itemStyle: { color: string };
}

export interface NetworkChartOption {
	tooltip: { trigger: "item"; confine: boolean };
	legend: { data: string[]; bottom: number; itemWidth: number; itemHeight: number; textStyle: { fontSize: number } };
	series: Array<{
		type: "graph";
		layout: "force";
		roam: boolean;
		draggable: boolean;
		force: { repulsion: number; edgeLength: number; gravity: number };
		emphasis: { focus: "adjacency"; label: { show: boolean } };
		label: { show: boolean; fontSize: number; position: "right" };
		labelLayout: { hideOverlap: boolean };
		lineStyle: { color: string; curveness: number; width: number };
		data: ChartGraphNode[];
		links: ChartGraphLink[];
		categories: ChartCategory[];
	}>;
}

// Category order doubles as the legend order: containment first, ingress chain
// second, overlay last. Colors from the Tommy Hilfiger app palette (app.css).
const KIND_CATEGORIES: ReadonlyArray<{ kind: NetworkTopologyNode["kind"]; label: string; color: string }> = [
	{ kind: "vpc", label: "VPC", color: "#02154E" }, // tommy-navy
	{ kind: "subnet", label: "Subnet", color: "#166C96" }, // tommy-accent-blue
	{ kind: "workload", label: "Workload", color: "#2E8B57" },
	{ kind: "eni", label: "ENI", color: "#7A8AA6" },
	{ kind: "loadBalancer", label: "Load balancer", color: "#D61233" }, // tommy-red
	{ kind: "targetGroup", label: "Target group", color: "#B06A0F" },
	{ kind: "dnsRecord", label: "DNS record", color: "#5B3E96" },
	{ kind: "serviceEndpoint", label: "Endpoint", color: "#1B2651" }, // tommy-dark-navy
];

const SYMBOL_SIZE: Record<NetworkTopologyNode["kind"], number> = {
	vpc: 46,
	subnet: 32,
	loadBalancer: 28,
	dnsRecord: 22,
	targetGroup: 20,
	workload: 16,
	serviceEndpoint: 16,
	eni: 10,
};

// Workload/ENI labels stay hidden until hover (emphasis) so a dense map is
// readable at default zoom; structural nodes keep their labels on.
const LABELED_KINDS: ReadonlySet<NetworkTopologyNode["kind"]> = new Set([
	"vpc",
	"subnet",
	"loadBalancer",
	"dnsRecord",
	"serviceEndpoint",
]);

function nodeLabel(node: NetworkTopologyNode): string {
	if (node.kind === "serviceEndpoint" && node.endpoint) {
		const hostPort =
			node.endpoint.port !== undefined ? `${node.endpoint.host}:${node.endpoint.port}` : node.endpoint.host;
		return node.name ? `${node.name} (${hostPort})` : hostPort;
	}
	if (node.name) return node.name;
	return node.id;
}

function tooltipLines(node: NetworkTopologyNode): string[] {
	const lines: string[] = [`<b>${nodeLabel(node)}</b>`];
	lines.push(node.kind);
	if (node.id !== nodeLabel(node)) lines.push(node.id);
	if (node.cidr) lines.push(`cidr ${node.cidr}`);
	if (node.availabilityZone) lines.push(node.availabilityZone);
	if (node.privateIps?.length) lines.push(node.privateIps.join(", "));
	if (node.dnsName) lines.push(node.dnsName);
	if (node.recordType) lines.push(`type ${node.recordType}`);
	if (node.scheme || node.lbType) lines.push([node.lbType, node.scheme].filter(Boolean).join(" / "));
	if (node.health) lines.push(`${node.health.healthy}/${node.health.total} targets healthy`);
	if (node.endpoint) lines.push(`via ${node.endpoint.datasource}`);
	if (node.service) lines.push(`service: ${node.service}`);
	if (node.estate) lines.push(`estate: ${node.estate}`);
	return lines;
}

export function buildNetworkChartOption(topology: NetworkTopology): NetworkChartOption {
	const categoryIndex = new Map(KIND_CATEGORIES.map((c, i) => [c.kind, i]));
	const usedCategories = new Set<number>();

	const data: ChartGraphNode[] = topology.nodes.map((node) => {
		const category = categoryIndex.get(node.kind) ?? 0;
		usedCategories.add(category);
		const unhealthy = node.health !== undefined && node.health.healthy < node.health.total;
		return {
			id: node.id,
			name: nodeLabel(node),
			category,
			symbolSize: SYMBOL_SIZE[node.kind],
			label: { show: LABELED_KINDS.has(node.kind) },
			tooltip: { formatter: tooltipLines(node).join("<br/>") },
			// Unhealthy target groups get a red ring so degradation is visible
			// without opening the tooltip.
			...(unhealthy && { itemStyle: { borderColor: "#D61233", borderWidth: 3 } }),
		};
	});

	const links: ChartGraphLink[] = topology.edges.map((edge) => ({
		source: edge.from,
		target: edge.to,
		// CIDR-derived placement renders dashed (vs solid API-confirmed edges).
		...(edge.derived && { lineStyle: { type: "dashed" as const } }),
		...(edge.detail && { label: { show: true, formatter: edge.detail, fontSize: 9 } }),
	}));

	const categories: ChartCategory[] = KIND_CATEGORIES.map((c) => ({
		name: c.label,
		itemStyle: { color: c.color },
	}));

	return {
		tooltip: { trigger: "item", confine: true },
		legend: {
			data: KIND_CATEGORIES.filter((_, i) => usedCategories.has(i)).map((c) => c.label),
			bottom: 0,
			itemWidth: 10,
			itemHeight: 10,
			textStyle: { fontSize: 10 },
		},
		series: [
			{
				type: "graph",
				layout: "force",
				roam: true,
				draggable: true,
				force: { repulsion: 300, edgeLength: 120, gravity: 0.1 },
				emphasis: { focus: "adjacency", label: { show: true } },
				label: { show: false, fontSize: 10, position: "right" },
				labelLayout: { hideOverlap: true },
				lineStyle: { color: "#9ca3af", curveness: 0.1, width: 1 },
				data,
				links,
				categories,
			},
		],
	};
}
