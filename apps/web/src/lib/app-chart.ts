// apps/web/src/lib/app-chart.ts
import type { ApplicationTopology, ApplicationTopologyNode } from "@devops-agent/shared";
import type {
	ChartCategory,
	ChartGraphLink,
	ChartGraphNode,
	NetworkChartOption,
	TopologyTextSummary,
} from "./network-chart.ts";

// SIO-1457: pure ApplicationTopology -> ECharts graph-series option transform,
// mirroring network-chart.ts (unit-testable, no echarts/DOM imports; the option
// SHAPE is identical so NetworkChartOption is reused). Hues deliberately disjoint
// from the network map's eight so both cards on one message read as different
// layers, not one map split in two.

// 0.05 mirrors ElasticFindingsCard's red errorRateClass threshold -- one
// definition of "unhealthy" across the APM surfaces.
const UNHEALTHY_ERROR_RATE = 0.05;

const KIND_CATEGORIES: ReadonlyArray<{ kind: ApplicationTopologyNode["kind"]; label: string; color: string }> = [
	{ kind: "service", label: "Service", color: "#0F766E" }, // teal-700
	{ kind: "dependency", label: "Dependency", color: "#9333EA" }, // purple-600
	{ kind: "kafkaTopic", label: "Kafka topic", color: "#C2410C" }, // orange-700
	{ kind: "consumerGroup", label: "Consumer group", color: "#A16207" }, // yellow-700
	{ kind: "awsResource", label: "AWS resource", color: "#475569" }, // slate-600
];

const SYMBOL_SIZE: Record<ApplicationTopologyNode["kind"], number> = {
	service: 34,
	dependency: 24,
	kafkaTopic: 22,
	consumerGroup: 20,
	awsResource: 16,
};

// AWS resource labels (long ARNs) stay hidden until hover. SIO-1460: dependency
// nodes are also unlabeled at rest -- even with host families collapsed they are the
// densest kind, and hover/emphasis plus the SIO-1459 text view still surface names.
const LABELED_KINDS: ReadonlySet<ApplicationTopologyNode["kind"]> = new Set(["service", "kafkaTopic", "consumerGroup"]);

function nodeLabel(node: ApplicationTopologyNode): string {
	return node.name ?? node.id;
}

// ECharts injects the tooltip formatter string as innerHTML, so every dynamic
// value below must be escaped (same rule as network-chart.ts).
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Plain-text description lines for one node -- the single source both renderers
// share: the HTML tooltip escapes+wraps them, the SIO-1459 accessible text view
// interpolates them as Svelte text (no escaping needed there).
function nodeDescriptionLines(node: ApplicationTopologyNode): string[] {
	const lines: string[] = [node.kind];
	if (node.id !== nodeLabel(node)) lines.push(node.id);
	if (node.errorRate !== undefined) lines.push(`error rate ${(node.errorRate * 100).toFixed(1)}%`);
	if (node.avgDurationMs !== undefined) lines.push(`avg ${Math.round(node.avgDurationMs)}ms`);
	if (node.transactionCount !== undefined) lines.push(`${node.transactionCount} transactions`);
	if (node.service) lines.push(`service: ${node.service}`);
	return lines;
}

function tooltipLines(node: ApplicationTopologyNode): string[] {
	return [`<b>${escapeHtml(nodeLabel(node))}</b>`, ...nodeDescriptionLines(node).map(escapeHtml)];
}

// SIO-1459: accessible text representation (see network-chart.ts's
// buildNetworkTextSummary -- same shape, reused by the card's text view).
export function buildApplicationTextSummary(topology: ApplicationTopology): TopologyTextSummary {
	const byId = new Map(topology.nodes.map((n) => [n.id, n]));
	const label = (id: string): string => {
		const n = byId.get(id);
		return n ? nodeLabel(n) : id;
	};
	const nodes = topology.nodes.map((n) => `${nodeLabel(n)}: ${nodeDescriptionLines(n).join(", ")}`);
	const edges = topology.edges.map((e) => {
		const notes = [e.detail, e.priorKnowledge ? "prior knowledge from earlier incidents" : undefined].filter(Boolean);
		return `${label(e.from)} ${e.kind} ${label(e.to)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
	});
	return { nodes, edges };
}

export function buildApplicationChartOption(topology: ApplicationTopology): NetworkChartOption {
	const categoryIndex = new Map(KIND_CATEGORIES.map((c, i) => [c.kind, i]));
	const usedCategories = new Set<number>();

	const data: ChartGraphNode[] = topology.nodes.map((node) => {
		const category = categoryIndex.get(node.kind) ?? 0;
		usedCategories.add(category);
		const unhealthy = node.errorRate !== undefined && node.errorRate >= UNHEALTHY_ERROR_RATE;
		return {
			id: node.id,
			name: nodeLabel(node),
			category,
			symbolSize: SYMBOL_SIZE[node.kind],
			label: { show: LABELED_KINDS.has(node.kind) },
			tooltip: { formatter: tooltipLines(node).join("<br/>") },
			// Services above the APM error-rate threshold get a red ring so
			// degradation is visible without opening the tooltip.
			...(unhealthy && { itemStyle: { borderColor: "#D61233", borderWidth: 3 } }),
		};
	});

	const links: ChartGraphLink[] = topology.edges.map((edge) => ({
		source: edge.from,
		target: edge.to,
		// KG prior-knowledge edges render dashed (vs solid observed-this-turn edges).
		...(edge.priorKnowledge && { lineStyle: { type: "dashed" as const } }),
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
