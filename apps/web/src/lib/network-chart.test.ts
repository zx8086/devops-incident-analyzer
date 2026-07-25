// apps/web/src/lib/network-chart.test.ts
import { describe, expect, test } from "bun:test";
import type { NetworkTopology } from "@devops-agent/shared";
import { buildNetworkChartOption } from "./network-chart.ts";

const TOPOLOGY: NetworkTopology = {
	builtAtTurn: 1,
	sources: ["aws", "kafka"],
	nodes: [
		{ id: "vpc-0ab", kind: "vpc", cidr: "10.34.0.0/16", estate: "prod" },
		{ id: "subnet-1", kind: "subnet", cidr: "10.34.50.0/24", availabilityZone: "eu-west-1a" },
		{ id: "arn:tg/orders", kind: "targetGroup", name: "orders-tg", health: { healthy: 1, total: 3 } },
		{ id: "arn:ecs:task/orders/abc", kind: "workload", name: "orders-service", privateIps: ["10.34.50.147"] },
		{
			id: "ep:kafka:b-1.example.com:9098",
			kind: "serviceEndpoint",
			name: "broker-1",
			endpoint: { host: "b-1.example.com", port: 9098, datasource: "kafka" },
		},
	],
	edges: [
		{ from: "subnet-1", to: "vpc-0ab", kind: "in-vpc" },
		{ from: "arn:ecs:task/orders/abc", to: "subnet-1", kind: "in-subnet", derived: true },
		{ from: "arn:tg/orders", to: "arn:ecs:task/orders/abc", kind: "targets", detail: "port 8080" },
	],
};

// Strict-index helper: the option always carries exactly one graph series.
function graphSeries(option: ReturnType<typeof buildNetworkChartOption>) {
	const series = option.series[0];
	if (!series) throw new Error("option.series is empty");
	return series;
}

describe("buildNetworkChartOption", () => {
	test("maps nodes to categorized graph data with kind-scaled symbols", () => {
		const option = buildNetworkChartOption(TOPOLOGY);
		const series = graphSeries(option);
		expect(series.type).toBe("graph");
		expect(series.layout).toBe("force");
		expect(series.roam).toBe(true);
		const byId = new Map(series.data.map((d) => [d.id, d]));
		const vpc = byId.get("vpc-0ab");
		const workload = byId.get("arn:ecs:task/orders/abc");
		expect(vpc).toBeDefined();
		expect(workload).toBeDefined();
		if (!vpc || !workload) return;
		expect(vpc.symbolSize).toBeGreaterThan(workload.symbolSize);
		expect(vpc.category).not.toBe(workload.category);
		// Structural nodes are labeled at rest; workloads only on emphasis.
		expect(vpc.label?.show).toBe(true);
		expect(workload.label?.show).toBe(false);
		expect(workload.name).toBe("orders-service");
	});

	test("derived edges render dashed; detail edges get labels", () => {
		const option = buildNetworkChartOption(TOPOLOGY);
		const links = graphSeries(option).links;
		const derived = links.find((l) => l.source === "arn:ecs:task/orders/abc" && l.target === "subnet-1");
		expect(derived?.lineStyle?.type).toBe("dashed");
		const plain = links.find((l) => l.source === "subnet-1");
		expect(plain?.lineStyle).toBeUndefined();
		const detail = links.find((l) => l.source === "arn:tg/orders");
		expect(detail?.label?.formatter).toBe("port 8080");
	});

	test("unhealthy target groups get the red warning ring", () => {
		const option = buildNetworkChartOption(TOPOLOGY);
		const tg = graphSeries(option).data.find((d) => d.id === "arn:tg/orders");
		expect(tg?.itemStyle?.borderColor).toBe("#D61233");
		const healthyTopology: NetworkTopology = {
			...TOPOLOGY,
			nodes: [{ id: "arn:tg/ok", kind: "targetGroup", health: { healthy: 2, total: 2 } }],
			edges: [],
		};
		const ok = graphSeries(buildNetworkChartOption(healthyTopology)).data[0];
		expect(ok?.itemStyle).toBeUndefined();
	});

	test("legend lists only categories present in the topology", () => {
		const option = buildNetworkChartOption(TOPOLOGY);
		expect(option.legend.data.sort()).toEqual(["Endpoint", "Subnet", "Target group", "VPC", "Workload"].sort());
	});

	test("tooltip formatter escapes HTML in dynamic values (XSS)", () => {
		// ECharts renders the tooltip formatter string as innerHTML; a hostile node
		// name (e.g. an AWS Name tag) must never survive as live markup.
		const evil: NetworkTopology = {
			builtAtTurn: 1,
			sources: ["aws"],
			nodes: [{ id: "i-evil", kind: "workload", name: "<img src=x onerror=alert(1)>" }],
			edges: [],
		};
		const node = graphSeries(buildNetworkChartOption(evil)).data[0];
		expect(node?.tooltip?.formatter).not.toContain("<img");
		expect(node?.tooltip?.formatter).toContain("&lt;img src=x onerror=alert(1)&gt;");
		// The static markup stays raw HTML; canvas-rendered data[].name stays verbatim.
		expect(node?.tooltip?.formatter).toContain("<b>");
		expect(node?.name).toBe("<img src=x onerror=alert(1)>");
	});

	test("tooltips carry placement and health detail", () => {
		const option = buildNetworkChartOption(TOPOLOGY);
		const tg = graphSeries(option).data.find((d) => d.id === "arn:tg/orders");
		expect(tg?.tooltip?.formatter).toContain("1/3 targets healthy");
		const ep = graphSeries(option).data.find((d) => d.id === "ep:kafka:b-1.example.com:9098");
		expect(ep?.name).toBe("broker-1 (b-1.example.com:9098)");
		expect(ep?.tooltip?.formatter).toContain("via kafka");
	});
});
