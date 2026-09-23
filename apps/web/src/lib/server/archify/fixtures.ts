// apps/web/src/lib/server/archify/fixtures.ts
import type { ApplicationTopology, NetworkTopology } from "@devops-agent/shared";

// SIO-1876: synthetic topologies shaped like the builders' output (the repo is public: no captured
// prod data). Two VPCs, subnets on both, an ungrouped endpoint, and a hostile name.
export const NETWORK_FIXTURE: NetworkTopology = {
	builtAtTurn: 1,
	sources: ["aws", "kafka"],
	nodes: [
		{ id: "vpc-0ab", kind: "vpc", name: "prod-vpc", cidr: "10.34.0.0/16", estate: "prod" },
		{ id: "vpc-0cd", kind: "vpc", name: "shared-vpc", cidr: "10.40.0.0/16", estate: "prod" },
		{ id: "subnet-1", kind: "subnet", cidr: "10.34.50.0/24", availabilityZone: "eu-west-1a" },
		{ id: "subnet-2", kind: "subnet", cidr: "10.34.51.0/24", availabilityZone: "eu-west-1b" },
		{ id: "subnet-3", kind: "subnet", cidr: "10.40.10.0/24", availabilityZone: "eu-west-1a" },
		{ id: "dns:orders.example.com:A", kind: "dnsRecord", name: "orders.example.com", recordType: "ALIAS" },
		{ id: "arn:lb/orders", kind: "loadBalancer", name: "orders-alb", scheme: "internal", lbType: "application" },
		{ id: "arn:tg/orders", kind: "targetGroup", name: "orders-tg", health: { healthy: 1, total: 3 } },
		{ id: "arn:ecs:task/orders/abc", kind: "workload", name: "orders-service", privateIps: ["10.34.50.147"] },
		{ id: "arn:ecs:task/orders/def", kind: "workload", name: "orders-service", privateIps: ["10.34.51.12"] },
		{ id: "eni-0aa", kind: "eni", privateIps: ["10.34.50.147"] },
		{
			id: "arn:ecs:task/ledger/xyz",
			kind: "workload",
			name: '<img src=x onerror="alert(1)">',
			privateIps: ["10.40.10.9"],
		},
		{
			id: "ep:kafka:b-1.example.com:9098",
			kind: "serviceEndpoint",
			name: "broker-1",
			endpoint: { host: "b-1.example.com", port: 9098, datasource: "kafka" },
		},
	],
	edges: [
		{ from: "subnet-1", to: "vpc-0ab", kind: "in-vpc" },
		{ from: "subnet-2", to: "vpc-0ab", kind: "in-vpc" },
		{ from: "subnet-3", to: "vpc-0cd", kind: "in-vpc" },
		{ from: "arn:lb/orders", to: "vpc-0ab", kind: "in-vpc" },
		{ from: "arn:ecs:task/orders/abc", to: "subnet-1", kind: "in-subnet", derived: true },
		{ from: "arn:ecs:task/orders/def", to: "subnet-2", kind: "in-subnet" },
		{ from: "eni-0aa", to: "subnet-1", kind: "in-subnet" },
		{ from: "arn:ecs:task/ledger/xyz", to: "subnet-3", kind: "in-subnet" },
		{ from: "dns:orders.example.com:A", to: "arn:lb/orders", kind: "resolves-to" },
		{ from: "arn:lb/orders", to: "arn:tg/orders", kind: "routes-to", detail: "HTTPS:443" },
		{ from: "arn:tg/orders", to: "arn:ecs:task/orders/abc", kind: "targets", detail: "port 8080" },
		{ from: "arn:tg/orders", to: "arn:ecs:task/orders/def", kind: "targets", detail: "port 8080" },
		{ from: "eni-0aa", to: "arn:ecs:task/orders/abc", kind: "attached-to" },
	],
};

export const APPLICATION_FIXTURE: ApplicationTopology = {
	builtAtTurn: 1,
	sources: ["elastic", "kafka", "knowledge-graph"],
	nodes: [
		{ id: "svc:checkout-service", kind: "service", name: "checkout-service", errorRate: 0.08, avgDurationMs: 240 },
		{ id: "svc:payment-service", kind: "service", name: "payment-service", errorRate: 0.001, avgDurationMs: 90 },
		{ id: "dep:postgresql", kind: "dependency", name: "postgresql" },
		{ id: "topic:orders", kind: "kafkaTopic", name: "orders" },
		{ id: "cg:order-workers", kind: "consumerGroup", name: "order-workers (Stable)" },
		{ id: "aws:arn:aws:ecs:eu-west-1:1:service/prod/checkout", kind: "awsResource", name: "checkout" },
	],
	edges: [
		{ from: "svc:checkout-service", to: "svc:payment-service", kind: "calls", detail: "avg 240ms, 2.1% err" },
		{ from: "svc:checkout-service", to: "dep:postgresql", kind: "calls" },
		{ from: "cg:order-workers", to: "topic:orders", kind: "consumes", detail: "lag 1200" },
		{
			from: "svc:checkout-service",
			to: "aws:arn:aws:ecs:eu-west-1:1:service/prod/checkout",
			kind: "runs-on",
			priorKnowledge: true,
		},
	],
};

// SIO-1878: the two shapes from a user report, synthetic names. Network: every link is containment
// (so the diagram has boundaries and no connections) plus three unlinked brokers. Application: five
// services and one dependency, tall enough to overflow a fixed-height frame.
export const REPORTED_NETWORK_FIXTURE: NetworkTopology = {
	builtAtTurn: 1,
	sources: ["kafka", "aws"],
	nodes: [
		{ id: "vpc-0aa", kind: "vpc", name: "example-prd-vpc", cidr: "10.35.0.0/16" },
		{ id: "subnet-a", kind: "subnet", cidr: "10.35.12.0/24" },
		{ id: "subnet-b", kind: "subnet", cidr: "10.35.13.0/24" },
		{ id: "subnet-c", kind: "subnet", cidr: "10.35.14.0/24" },
		{
			id: "arn:task/a",
			kind: "workload",
			name: "orders-service",
			privateIps: ["10.35.12.10"],
			service: "orders-service",
		},
		{
			id: "arn:task/b",
			kind: "workload",
			name: "orders-service",
			privateIps: ["10.35.13.10"],
			service: "orders-service",
		},
		{
			id: "arn:task/c",
			kind: "workload",
			name: "orders-service",
			privateIps: ["10.35.14.10"],
			service: "orders-service",
		},
		...[1, 2, 3].map((i) => ({
			id: `ep:kafka:b-${i}.example.com:9098`,
			kind: "serviceEndpoint" as const,
			name: `broker-${i}`,
			endpoint: { host: `b-${i}.example.com`, port: 9098, datasource: "kafka" },
		})),
	],
	edges: [
		{ from: "subnet-a", to: "vpc-0aa", kind: "in-vpc" },
		{ from: "subnet-b", to: "vpc-0aa", kind: "in-vpc" },
		{ from: "subnet-c", to: "vpc-0aa", kind: "in-vpc" },
		{ from: "arn:task/a", to: "subnet-a", kind: "in-subnet", derived: true },
		{ from: "arn:task/b", to: "subnet-b", kind: "in-subnet", derived: true },
		{ from: "arn:task/c", to: "subnet-c", kind: "in-subnet", derived: true },
	],
};

export const REPORTED_APPLICATION_FIXTURE: ApplicationTopology = {
	builtAtTurn: 1,
	sources: ["elastic", "kafka"],
	nodes: [
		{ id: "svc:orders-service", kind: "service", name: "orders-service", errorRate: 0, avgDurationMs: 23 },
		{ id: "svc:catalog-service", kind: "service", name: "catalog-service", errorRate: 0, avgDurationMs: 360 },
		{ id: "svc:checkout-service", kind: "service", name: "checkout-service", errorRate: 0, avgDurationMs: 28 },
		{ id: "svc:orders.example.com:443", kind: "service", name: "orders.example.com:443" },
		{ id: "svc:orders.dev.example.com:443", kind: "service", name: "orders.dev.example.com:443", errorRate: 1 },
		{ id: "dep:storefront", kind: "dependency", name: "storefront (29 locales)" },
	],
	edges: [
		{ from: "svc:catalog-service", to: "dep:storefront", kind: "calls", detail: "avg 360ms, 0.0% err" },
		{ from: "svc:orders-service", to: "dep:storefront", kind: "calls", detail: "avg 23ms, 0.0% err" },
		{ from: "svc:checkout-service", to: "dep:storefront", kind: "calls", detail: "avg 28ms, 0.0% err" },
		{ from: "svc:orders.example.com:443", to: "svc:checkout-service", kind: "calls", detail: "avg 6ms, 0.0% err" },
		{ from: "svc:orders.example.com:443", to: "svc:catalog-service", kind: "calls", detail: "avg 38ms, 0.0% err" },
		{
			from: "svc:orders.dev.example.com:443",
			to: "svc:catalog-service",
			kind: "calls",
			detail: "avg 21ms, 100.0% err",
		},
	],
};
