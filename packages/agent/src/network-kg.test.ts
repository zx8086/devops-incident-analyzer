// agent/src/network-kg.test.ts
import { describe, expect, test } from "bun:test";
import type { NetworkMap } from "@devops-agent/knowledge-graph";
import { NETWORK_DISCOVERED_BY } from "@devops-agent/knowledge-graph";
import type { NetworkTopology } from "@devops-agent/shared";
import { deriveNetworkTopology, renderNetworkContextLine } from "./network-kg.ts";
import { extractIpv4Tokens } from "./resolve-identifiers.ts";

const TOPOLOGY: NetworkTopology = {
	builtAtTurn: 3,
	sources: ["aws", "konnect"],
	nodes: [
		{ id: "vpc-0ab", kind: "vpc", cidr: "10.34.0.0/16", name: "orders-vpc", estate: "prod" },
		{ id: "subnet-1", kind: "subnet", cidr: "10.34.50.0/24", availabilityZone: "eu-west-1a" },
		{
			id: "arn:lb/orders",
			kind: "loadBalancer",
			name: "orders-prod",
			dnsName: "x.elb",
			lbType: "application",
			scheme: "internal",
		},
		{ id: "arn:tg/orders", kind: "targetGroup", name: "orders-tg" },
		{
			id: "dns:orders.example.com:A",
			kind: "dnsRecord",
			name: "orders.example.com",
			recordType: "A",
			dnsName: "x.elb",
		},
		{ id: "arn:ecs:task/orders/abc", kind: "workload", name: "orders-service", privateIps: ["10.34.50.147"] },
		{ id: "ip:10.34.50.9", kind: "workload", name: "10.34.50.9", privateIps: ["10.34.50.9"] },
		{ id: "eni-1", kind: "eni", privateIps: ["10.34.50.10"] },
		{
			id: "ep:konnect:orders.svc:8443",
			kind: "serviceEndpoint",
			name: "orders-service",
			service: "orders-service",
			endpoint: { host: "orders.svc", port: 8443, protocol: "https", datasource: "konnect" },
		},
		{
			id: "ep:kafka:b-1:9092",
			kind: "serviceEndpoint",
			name: "broker-1",
			endpoint: { host: "b-1", port: 9092, datasource: "kafka" },
		},
	],
	edges: [
		{ from: "subnet-1", to: "vpc-0ab", kind: "in-vpc" },
		{ from: "arn:lb/orders", to: "subnet-1", kind: "attached-to" },
		{ from: "arn:lb/orders", to: "arn:tg/orders", kind: "routes-to", detail: "HTTPS:443" },
		{ from: "arn:tg/orders", to: "arn:ecs:task/orders/abc", kind: "targets" },
		{ from: "arn:tg/orders", to: "ip:10.34.50.9", kind: "targets" },
		{ from: "dns:orders.example.com:A", to: "arn:lb/orders", kind: "resolves-to" },
		{ from: "arn:ecs:task/orders/abc", to: "subnet-1", kind: "in-subnet", derived: true },
	],
};

describe("deriveNetworkTopology", () => {
	test("returns undefined for absent or empty topologies", () => {
		expect(deriveNetworkTopology(undefined, "inc-1")).toBeUndefined();
		expect(deriveNetworkTopology({ builtAtTurn: 1, sources: [], nodes: [], edges: [] }, "inc-1")).toBeUndefined();
	});

	test("maps every layer onto the KG record shape", () => {
		const rec = deriveNetworkTopology(TOPOLOGY, "inc-1");
		expect(rec).toBeDefined();
		if (!rec) return;
		expect(rec.vpcs).toEqual([{ id: "vpc-0ab", cidr: "10.34.0.0/16", name: "orders-vpc" }]);
		expect(rec.subnets).toEqual([{ id: "subnet-1", cidr: "10.34.50.0/24", az: "eu-west-1a", vpcId: "vpc-0ab" }]);
		expect(rec.loadBalancers).toEqual([
			{
				arn: "arn:lb/orders",
				name: "orders-prod",
				dnsName: "x.elb",
				type: "application",
				scheme: "internal",
				subnetIds: ["subnet-1"],
			},
		]);
		expect(rec.targetGroups).toEqual([
			{
				arn: "arn:tg/orders",
				name: "orders-tg",
				loadBalancerArn: "arn:lb/orders",
				// synthetic ip: targets become isIp entries with the bare address.
				targets: [
					{ id: "arn:ecs:task/orders/abc", isIp: false },
					{ id: "10.34.50.9", isIp: true },
				],
			},
		]);
		expect(rec.dnsRecords).toEqual([
			{ name: "orders.example.com", type: "A", target: "x.elb", loadBalancerArn: "arn:lb/orders" },
		]);
	});

	test("only service-linked endpoints persist (HAS_ENDPOINT needs a Service anchor)", () => {
		const rec = deriveNetworkTopology(TOPOLOGY, "inc-1");
		expect(rec?.endpoints).toEqual([
			{ service: "orders-service", host: "orders.svc", port: 8443, protocol: "https", datasource: "konnect" },
		]);
	});

	test("ip bindings come from real workloads only, with subnet placement and incident provenance", () => {
		const rec = deriveNetworkTopology(TOPOLOGY, "inc-1");
		expect(rec?.ipBindings).toEqual([
			{
				ip: "10.34.50.147",
				workloadArn: "arn:ecs:task/orders/abc",
				subnetId: "subnet-1",
				confidence: 0.7,
				discoveredBy: NETWORK_DISCOVERED_BY,
				evidence: "network-map:aws+konnect",
				incidentId: "inc-1",
			},
		]);
		// synthetic ip: nodes and ENIs never become BOUND_TO edges.
		expect(rec?.ipBindings.some((b) => b.workloadArn.startsWith("ip:"))).toBe(false);
		expect(rec?.ipBindings.some((b) => b.workloadArn === "eni-1")).toBe(false);
	});
});

describe("renderNetworkContextLine", () => {
	const EMPTY: NetworkMap = {
		service: "orders",
		workloads: [],
		targetGroups: [],
		loadBalancers: [],
		dnsRecords: [],
		placements: [],
		ipAddresses: [],
		endpoints: [],
	};

	test("empty map renders nothing", () => {
		expect(renderNetworkContextLine("orders", EMPTY)).toBe("");
	});

	test("renders placement, lb+dns, ips, and endpoints in one bounded line", () => {
		const line = renderNetworkContextLine("orders", {
			...EMPTY,
			placements: [
				{
					loadBalancerArn: "arn:lb-1",
					subnetId: "subnet-1",
					subnetCidr: "10.0.1.0/24",
					az: "eu-west-1a",
					vpcId: "vpc-1",
					vpcCidr: "10.0.0.0/16",
					vpcName: "prod",
				},
			],
			loadBalancers: [
				{
					arn: "arn:lb-1",
					name: "orders-alb",
					dnsName: "x.elb",
					type: "application",
					scheme: "internal",
					targetGroupArn: "arn:tg-1",
				},
			],
			dnsRecords: [{ name: "orders.internal", type: "A", target: "x.elb", loadBalancerArn: "arn:lb-1" }],
			ipAddresses: [
				{
					ip: "10.0.1.15",
					workloadArn: "arn:task",
					subnetId: "subnet-1",
					lastVerified: "t9",
					discoveredBy: "network-map",
				},
			],
			endpoints: [
				{
					id: "b-1:9092",
					host: "b-1",
					port: 9092,
					protocol: "tcp",
					datasource: "kafka",
					confidence: 0.7,
					lastVerified: "t9",
				},
			],
		});
		expect(line).toBe(
			"- known topology: orders in prod (10.0.0.0/16); behind application orders-alb (dns orders.internal); last-known IPs 10.0.1.15; endpoints: kafka b-1:9092",
		);
	});
});

describe("extractIpv4Tokens", () => {
	test("finds valid IPv4 literals and rejects octet overflows", () => {
		expect(extractIpv4Tokens(["what owns 10.34.50.147?", "version 10.2.300.1 deployed", "10.34.50.147 again"])).toEqual(
			["10.34.50.147"],
		);
		expect(extractIpv4Tokens(["no ips here"])).toEqual([]);
	});
});
