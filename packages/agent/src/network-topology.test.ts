// agent/src/network-topology.test.ts
// SIO-1204: fixtures mirror real MCP/SDK response shapes (PascalCase EC2/ELBv2/
// Route53 envelopes, lowerCamelCase ECS, Kong/Kafka/Elastic natives).
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildNetworkTopology, MAX_NODES, summarizeNetworkTopologyForPrompt } from "./network-topology.ts";

function awsResult(toolOutputs: { toolName: string; rawJson: unknown }[], estate = "prod-estate"): DataSourceResult {
	return { dataSourceId: "aws", deploymentId: estate, data: {}, status: "success", toolOutputs };
}

const VPC_OUT = {
	toolName: "aws_ec2_describe_vpcs",
	rawJson: {
		Vpcs: [{ VpcId: "vpc-0ab", CidrBlock: "10.34.0.0/16", Tags: [{ Key: "Name", Value: "orders-vpc" }] }],
	},
};
const SUBNET_OUT = {
	toolName: "aws_ec2_describe_subnets",
	rawJson: {
		Subnets: [{ SubnetId: "subnet-1", VpcId: "vpc-0ab", CidrBlock: "10.34.50.0/24", AvailabilityZone: "eu-west-1a" }],
	},
};

describe("buildNetworkTopology - aws", () => {
	test("returns undefined when no outputs produced nodes", () => {
		expect(buildNetworkTopology([], [])).toBeUndefined();
		expect(
			buildNetworkTopology([{ dataSourceId: "aws", data: {}, status: "success", toolOutputs: [] }], []),
		).toBeUndefined();
	});

	test("vpc/subnet hierarchy with in-vpc edges and estate attribution", () => {
		const t = buildNetworkTopology([awsResult([VPC_OUT, SUBNET_OUT])], []);
		expect(t).toBeDefined();
		if (!t) return;
		const vpc = t.nodes.find((n) => n.id === "vpc-0ab");
		expect(vpc?.kind).toBe("vpc");
		expect(vpc?.cidr).toBe("10.34.0.0/16");
		expect(vpc?.name).toBe("orders-vpc");
		expect(vpc?.estate).toBe("prod-estate");
		expect(t.edges).toContainEqual({ from: "subnet-1", to: "vpc-0ab", kind: "in-vpc" });
		expect(t.sources).toEqual(["aws"]);
	});

	test("full ingress chain: dns -> lb -> tg (health) -> targets", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					{
						toolName: "aws_elbv2_describe_load_balancers",
						rawJson: {
							LoadBalancers: [
								{
									LoadBalancerArn: "arn:lb/orders",
									LoadBalancerName: "orders-prod",
									DNSName: "orders-alb-123.eu-west-1.elb.amazonaws.com",
									Type: "application",
									Scheme: "internal",
									AvailabilityZones: [{ SubnetId: "subnet-1", ZoneName: "eu-west-1a" }],
								},
							],
						},
					},
					{
						toolName: "aws_elbv2_describe_listeners",
						rawJson: {
							Listeners: [
								{
									LoadBalancerArn: "arn:lb/orders",
									Port: 443,
									Protocol: "HTTPS",
									DefaultActions: [{ TargetGroupArn: "arn:tg/orders" }],
								},
							],
						},
					},
					{
						toolName: "aws_elbv2_describe_target_groups",
						rawJson: {
							TargetGroups: [
								{
									TargetGroupArn: "arn:tg/orders",
									TargetGroupName: "orders-tg",
									Port: 8080,
									LoadBalancerArns: ["arn:lb/orders"],
								},
							],
						},
					},
					{
						// SIO-1204: the tool echoes TargetGroupArn (the SDK response omits it).
						toolName: "aws_elbv2_describe_target_health",
						rawJson: {
							TargetGroupArn: "arn:tg/orders",
							TargetHealthDescriptions: [
								{ Target: { Id: "10.34.50.147", Port: 8080 }, TargetHealth: { State: "healthy" } },
								{ Target: { Id: "i-0abc", Port: 8080 }, TargetHealth: { State: "unhealthy" } },
							],
						},
					},
					{
						toolName: "aws_route53_list_resource_record_sets",
						rawJson: {
							ResourceRecordSets: [
								{
									Name: "orders.example.com.",
									Type: "A",
									AliasTarget: { DNSName: "ORDERS-ALB-123.eu-west-1.elb.amazonaws.com." },
								},
								{ Name: "orders.example.com.", Type: "TXT", ResourceRecords: [{ Value: "ignored" }] },
							],
						},
					},
				]),
			],
			[],
		);
		expect(t).toBeDefined();
		if (!t) return;
		// TXT records are excluded; the alias A record matched the LB DNSName
		// case-insensitively with trailing dots stripped.
		expect(t.nodes.filter((n) => n.kind === "dnsRecord")).toHaveLength(1);
		expect(t.edges).toContainEqual({ from: "dns:orders.example.com:A", to: "arn:lb/orders", kind: "resolves-to" });
		expect(t.edges).toContainEqual({
			from: "arn:lb/orders",
			to: "arn:tg/orders",
			kind: "routes-to",
			detail: "HTTPS:443",
		});
		expect(t.edges).toContainEqual({ from: "arn:lb/orders", to: "subnet-1", kind: "attached-to" });
		const tg = t.nodes.find((n) => n.id === "arn:tg/orders");
		expect(tg?.health).toEqual({ healthy: 1, total: 2 });
		expect(t.edges).toContainEqual({
			from: "arn:tg/orders",
			to: "ip:10.34.50.147",
			kind: "targets",
			detail: "port 8080",
		});
		expect(t.edges).toContainEqual({ from: "arn:tg/orders", to: "i-0abc", kind: "targets", detail: "port 8080" });
	});

	test("target health without the TargetGroupArn echo is skipped (no attribution guess)", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					VPC_OUT,
					{
						toolName: "aws_elbv2_describe_target_health",
						rawJson: {
							TargetHealthDescriptions: [{ Target: { Id: "i-0abc" }, TargetHealth: { State: "healthy" } }],
						},
					},
				]),
			],
			[],
		);
		expect(t?.edges.filter((e) => e.kind === "targets")).toHaveLength(0);
	});

	test("explicit SubnetId wins; CIDR-derived placement is marked derived", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					SUBNET_OUT,
					{
						// ENI with explicit SubnetId -> non-derived in-subnet edge.
						toolName: "aws_ec2_describe_network_interfaces",
						rawJson: {
							NetworkInterfaces: [
								{ NetworkInterfaceId: "eni-1", PrivateIpAddress: "10.34.50.9", SubnetId: "subnet-1" },
							],
						},
					},
					{
						// ECS task with an IP inside subnet-1's CIDR but NO subnet detail ->
						// derived in-subnet edge via ipInCidr.
						toolName: "aws_ecs_describe_tasks",
						rawJson: {
							tasks: [
								{
									taskArn: "arn:ecs:task/orders/abc",
									group: "service:orders-service",
									attachments: [
										{
											type: "ElasticNetworkInterface",
											details: [{ name: "privateIPv4Address", value: "10.34.50.147" }],
										},
									],
								},
							],
						},
					},
				]),
			],
			["orders-service"],
		);
		expect(t).toBeDefined();
		if (!t) return;
		const eniEdge = t.edges.find((e) => e.kind === "in-subnet" && e.from === "eni-1");
		expect(eniEdge?.derived).toBeUndefined();
		const taskEdge = t.edges.find((e) => e.kind === "in-subnet" && e.from === "arn:ecs:task/orders/abc");
		expect(taskEdge).toEqual({ from: "arn:ecs:task/orders/abc", to: "subnet-1", kind: "in-subnet", derived: true });
		const task = t.nodes.find((n) => n.id === "arn:ecs:task/orders/abc");
		expect(task?.name).toBe("orders-service");
		expect(task?.service).toBe("orders-service");
	});

	test("cross-estate CIDR coincidences do not create derived edges", () => {
		const t = buildNetworkTopology(
			[
				awsResult([SUBNET_OUT], "estate-a"),
				awsResult(
					[
						{
							toolName: "aws_ecs_describe_tasks",
							rawJson: {
								tasks: [
									{
										taskArn: "arn:ecs:task/other/xyz",
										attachments: [
											{
												type: "ElasticNetworkInterface",
												details: [{ name: "privateIPv4Address", value: "10.34.50.200" }],
											},
										],
									},
								],
							},
						},
					],
					"estate-b",
				),
			],
			[],
		);
		expect(t?.edges.filter((e) => e.kind === "in-subnet")).toHaveLength(0);
	});

	test("prefers the _summary projection when present (SIO-833)", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					{
						toolName: "aws_elbv2_describe_load_balancers",
						rawJson: {
							LoadBalancers: [{ LoadBalancerArn: "arn:lb/truncated-view" }],
							_summary: [
								{ LoadBalancerArn: "arn:lb/a", DNSName: "a.elb.amazonaws.com" },
								{ LoadBalancerArn: "arn:lb/b", DNSName: "b.elb.amazonaws.com" },
							],
						},
					},
				]),
			],
			[],
		);
		expect(t?.nodes.map((n) => n.id).sort()).toEqual(["arn:lb/a", "arn:lb/b"]);
	});

	test("caps nodes at MAX_NODES and drops dangling edges", () => {
		const manySubnets = Array.from({ length: MAX_NODES + 50 }, (_, i) => ({
			SubnetId: `subnet-${i}`,
			VpcId: "vpc-0ab",
			CidrBlock: `10.${Math.floor(i / 250)}.${i % 250}.0/24`,
		}));
		const t = buildNetworkTopology(
			[awsResult([{ toolName: "aws_ec2_describe_subnets", rawJson: { Subnets: manySubnets } }])],
			[],
		);
		expect(t).toBeDefined();
		if (!t) return;
		expect(t.nodes.length).toBe(MAX_NODES);
		expect(t.truncated).toBe(true);
		const kept = new Set(t.nodes.map((n) => n.id));
		for (const e of t.edges) {
			expect(kept.has(e.from)).toBe(true);
			expect(kept.has(e.to)).toBe(true);
		}
	});

	test("malformed rawJson is skipped, never thrown", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					{ toolName: "aws_ec2_describe_vpcs", rawJson: "not json at all" },
					{ toolName: "aws_ec2_describe_subnets", rawJson: { Subnets: [{ nope: true }] } },
					VPC_OUT,
				]),
			],
			[],
		);
		expect(t?.nodes.map((n) => n.id)).toEqual(["vpc-0ab"]);
	});
});

describe("buildNetworkTopology - service-endpoint overlay", () => {
	test("kong service, kafka brokers, elastic nodes become serviceEndpoint nodes", () => {
		const t = buildNetworkTopology(
			[
				{
					dataSourceId: "konnect",
					data: {},
					status: "success",
					toolOutputs: [
						{
							toolName: "konnect_get_service",
							rawJson: { name: "orders-service", host: "orders.svc.internal", port: 8443, protocol: "https" },
						},
					],
				},
				{
					dataSourceId: "kafka",
					data: {},
					status: "success",
					toolOutputs: [
						{
							toolName: "kafka_describe_cluster",
							rawJson: {
								brokers: [{ nodeId: 1, host: "b-1.msk.example.com", port: 9098, rack: "euw1-az1" }],
							},
						},
					],
				},
				{
					dataSourceId: "elastic",
					data: {},
					status: "success",
					toolOutputs: [
						{
							toolName: "elasticsearch_get_nodes_info",
							rawJson: {
								nodes: {
									abc123: { name: "instance-0", ip: "10.34.60.5", transport_address: "10.34.60.5:9300" },
								},
							},
						},
					],
				},
			],
			["orders-service"],
		);
		expect(t).toBeDefined();
		if (!t) return;
		expect(t.sources.sort()).toEqual(["elastic", "kafka", "konnect"]);
		const kong = t.nodes.find((n) => n.id === "ep:konnect:orders.svc.internal:8443");
		expect(kong?.endpoint).toEqual({
			host: "orders.svc.internal",
			port: 8443,
			protocol: "https",
			datasource: "konnect",
		});
		expect(kong?.service).toBe("orders-service");
		const broker = t.nodes.find((n) => n.id === "ep:kafka:b-1.msk.example.com:9098");
		expect(broker?.name).toBe("broker-1");
		expect(broker?.availabilityZone).toBe("euw1-az1");
		const es = t.nodes.find((n) => n.id === "ep:elastic:10.34.60.5:9300");
		expect(es?.endpoint?.port).toBe(9300);
	});

	test("an IP-hosted endpoint gets a derived in-subnet edge against a known CIDR", () => {
		const t = buildNetworkTopology(
			[
				awsResult([SUBNET_OUT]),
				{
					dataSourceId: "elastic",
					data: {},
					status: "success",
					toolOutputs: [
						{
							toolName: "elasticsearch_get_nodes_info",
							rawJson: { nodes: { n1: { name: "es-0", ip: "10.34.50.42" } } },
						},
					],
				},
			],
			[],
		);
		const edge = t?.edges.find((e) => e.kind === "in-subnet" && e.from === "ep:elastic:10.34.50.42");
		expect(edge).toEqual({ from: "ep:elastic:10.34.50.42", to: "subnet-1", kind: "in-subnet", derived: true });
	});
});

describe("summarizeNetworkTopologyForPrompt", () => {
	test("renders hierarchy, ingress chain, and endpoints within the line cap", () => {
		const t = buildNetworkTopology(
			[
				awsResult([
					VPC_OUT,
					SUBNET_OUT,
					{
						toolName: "aws_elbv2_describe_load_balancers",
						rawJson: {
							LoadBalancers: [
								{
									LoadBalancerArn: "arn:lb/orders",
									LoadBalancerName: "orders-prod",
									DNSName: "orders-alb.elb.amazonaws.com",
									Type: "application",
									Scheme: "internal",
								},
							],
						},
					},
					{
						toolName: "aws_route53_list_resource_record_sets",
						rawJson: {
							ResourceRecordSets: [
								{ Name: "orders.example.com.", Type: "A", AliasTarget: { DNSName: "orders-alb.elb.amazonaws.com" } },
							],
						},
					},
				]),
			],
			[],
		);
		expect(t).toBeDefined();
		if (!t) return;
		const summary = summarizeNetworkTopologyForPrompt(t);
		const lines = summary.split("\n");
		expect(lines.length).toBeLessThanOrEqual(20);
		expect(summary).toContain("vpc vpc-0ab (10.34.0.0/16) [prod-estate]");
		expect(summary).toContain("orders.example.com A -> orders-prod (application/internal)");
	});
});
