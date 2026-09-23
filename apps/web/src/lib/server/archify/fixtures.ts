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
