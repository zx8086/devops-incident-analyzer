// apps/web/src/lib/app-chart.test.ts
import { describe, expect, test } from "bun:test";
import type { ApplicationTopology } from "@devops-agent/shared";
import { buildApplicationChartOption, buildApplicationTextSummary } from "./app-chart.ts";

const TOPOLOGY: ApplicationTopology = {
	builtAtTurn: 1,
	sources: ["elastic", "kafka", "knowledge-graph"],
	nodes: [
		{
			id: "svc:checkout-service",
			kind: "service",
			name: "checkout-service",
			errorRate: 0.08,
			avgDurationMs: 240,
			transactionCount: 10000,
			service: "checkout-service",
		},
		{ id: "svc:payment-service", kind: "service", name: "payment-service", errorRate: 0.001 },
		{ id: "dep:postgresql", kind: "dependency", name: "postgresql" },
		{ id: "topic:orders", kind: "kafkaTopic", name: "orders" },
		{ id: "cg:order-workers", kind: "consumerGroup", name: "order-workers (Stable)" },
		{ id: "aws:arn:aws:ecs:eu-west-1:1:service/prod/checkout", kind: "awsResource", name: "checkout" },
	],
	edges: [
		{ from: "svc:checkout-service", to: "svc:payment-service", kind: "calls", detail: "avg 240ms, 2.1% err" },
		{ from: "svc:checkout-service", to: "dep:postgresql", kind: "calls" },
		{ from: "cg:order-workers", to: "topic:orders", kind: "consumes", detail: "lag 1200" },
		{ from: "svc:checkout-service", to: "svc:payment-service", kind: "runs-on", priorKnowledge: true },
	],
};

// Strict-index helper: the option always carries exactly one graph series.
function graphSeries(option: ReturnType<typeof buildApplicationChartOption>) {
	const series = option.series[0];
	if (!series) throw new Error("option.series is empty");
	return series;
}

describe("buildApplicationChartOption", () => {
	test("maps nodes to categorized graph data with kind-scaled symbols", () => {
		const option = buildApplicationChartOption(TOPOLOGY);
		const series = graphSeries(option);
		expect(series.type).toBe("graph");
		expect(series.layout).toBe("force");
		const byId = new Map(series.data.map((d) => [d.id, d]));
		const service = byId.get("svc:checkout-service");
		const awsResource = byId.get("aws:arn:aws:ecs:eu-west-1:1:service/prod/checkout");
		expect(service).toBeDefined();
		expect(awsResource).toBeDefined();
		if (!service || !awsResource) return;
		expect(service.symbolSize).toBeGreaterThan(awsResource.symbolSize);
		expect(service.category).not.toBe(awsResource.category);
		// Short-named kinds are labeled at rest; ARN-named AWS resources only on hover.
		expect(service.label?.show).toBe(true);
		expect(awsResource.label?.show).toBe(false);
	});

	test("services above the APM error-rate threshold get the red ring; healthy ones do not", () => {
		const option = buildApplicationChartOption(TOPOLOGY);
		const byId = new Map(graphSeries(option).data.map((d) => [d.id, d]));
		expect(byId.get("svc:checkout-service")?.itemStyle?.borderColor).toBe("#D61233");
		expect(byId.get("svc:payment-service")?.itemStyle).toBeUndefined();
	});

	test("prior-knowledge edges render dashed; detail edges get labels", () => {
		const option = buildApplicationChartOption(TOPOLOGY);
		const links = graphSeries(option).links;
		const prior = links.find((l) => l.lineStyle?.type === "dashed");
		expect(prior?.source).toBe("svc:checkout-service");
		const observed = links.find((l) => l.source === "cg:order-workers");
		expect(observed?.lineStyle).toBeUndefined();
		expect(observed?.label?.formatter).toBe("lag 1200");
	});

	// SIO-1459: the accessible text view's data source -- one plain line per
	// node/edge, no HTML markup, same fields the tooltips carry.
	test("buildApplicationTextSummary renders every node and edge as plain text", () => {
		const summary = buildApplicationTextSummary(TOPOLOGY);
		expect(summary.nodes.length).toBe(TOPOLOGY.nodes.length);
		expect(summary.edges.length).toBe(TOPOLOGY.edges.length);
		expect(summary.nodes).toContainEqual(
			"checkout-service: service, svc:checkout-service, error rate 8.0%, avg 240ms, 10000 transactions, service: checkout-service",
		);
		expect(summary.edges).toContainEqual("checkout-service calls payment-service (avg 240ms, 2.1% err)");
		expect(summary.edges).toContainEqual(
			"checkout-service runs-on payment-service (prior knowledge from earlier incidents)",
		);
		// Plain text only -- no markup from the tooltip path leaks in.
		for (const line of [...summary.nodes, ...summary.edges]) {
			expect(line).not.toContain("<b>");
			expect(line).not.toContain("&lt;");
		}
	});

	test("tooltip values are HTML-escaped and legend lists only used categories", () => {
		const hostile: ApplicationTopology = {
			builtAtTurn: 0,
			sources: ["elastic"],
			nodes: [{ id: "svc:a", kind: "service", name: '<img src=x onerror="x">' }],
			edges: [],
		};
		const option = buildApplicationChartOption(hostile);
		const node = graphSeries(option).data[0];
		expect(node?.tooltip?.formatter).not.toContain("<img");
		expect(node?.tooltip?.formatter).toContain("&lt;img");
		// Only the service category is in use.
		expect(option.legend.data).toEqual(["Service"]);
	});
});
