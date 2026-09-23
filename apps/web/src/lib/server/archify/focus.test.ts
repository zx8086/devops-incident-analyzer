// apps/web/src/lib/server/archify/focus.test.ts
import { describe, expect, test } from "bun:test";
import type { NetworkTopology } from "@devops-agent/shared";
import { collapseDnsRecords, focusGraph } from "./focus.ts";

type N = { id: string; kind: string; service?: string };
type E = { from: string; to: string; kind: string };
const node = (id: string, extra: Partial<N> = {}): N => ({ id, kind: "service", ...extra });
const edge = (from: string, to: string, kind = "calls"): E => ({ from, to, kind });
const ids = (r: { nodes: N[] }) => r.nodes.map((n) => n.id).sort();

describe("focusGraph", () => {
	test("a map within the budget is returned whole, disconnected nodes included", () => {
		const nodes = [node("a", { service: "a" }), node("b"), node("lonely")];
		const r = focusGraph(nodes, [edge("a", "b")], 5);
		expect(ids(r)).toEqual(["a", "b", "lonely"]);
		expect(r.total).toBe(3);
	});

	// A chain seed -> n1 -> n2 -> n3 plus 20 unrelated hubs: the budget goes to the seed's
	// neighbourhood by distance before any unrelated node.
	test("spends the budget on the seed's neighbourhood nearest-first", () => {
		const chain = [node("seed", { service: "orders" }), node("n1"), node("n2"), node("n3")];
		const noise = Array.from({ length: 20 }, (_, i) => node(`x${i}`));
		const edges = [edge("seed", "n1"), edge("n1", "n2"), edge("n2", "n3"), edge("x0", "x1")];
		const r = focusGraph([...chain, ...noise], edges, 3);
		expect(ids(r)).toEqual(["n1", "n2", "seed"]);
		expect(r.seeds).toEqual(["seed"]);
		expect(r.edges).toEqual([edge("seed", "n1"), edge("n1", "n2")]);
	});

	// Live network map: 15 target groups hung off one ALB and took the whole budget as a star.
	test("a single hub cannot spend the whole budget on its own fan-out", () => {
		const leaves = Array.from({ length: 15 }, (_, i) => node(`tg${i}`));
		const otherHub = [node("hub2"), node("h2a"), node("h2b")];
		const edges = [
			...leaves.map((l) => edge("alb", l.id, "routes-to")),
			edge("hub2", "h2a"),
			edge("hub2", "h2b"),
			edge("alb", "hub2"),
		];
		const r = focusGraph([node("alb", { service: "orders" }), ...leaves, ...otherHub], edges, 8);
		// Capped, the seed brings in hub2 and only three leaves, which leaves budget for hub2's own
		// neighbours. Uncapped, six more leaves take that budget and hub2's neighbours never appear.
		expect(r.nodes.filter((n) => n.id.startsWith("tg")).length).toBeLessThanOrEqual(4);
		expect(ids(r)).toEqual(expect.arrayContaining(["hub2", "h2a", "h2b"]));
	});

	// Live network map: the six focus-linked workloads had no traffic edges at all.
	test("isolated seeds are kept and the busiest hub fills the rest of the budget", () => {
		const nodes = [
			node("w1", { service: "orders" }),
			node("w2", { service: "orders" }),
			node("hub"),
			node("h1"),
			node("h2"),
			...Array.from({ length: 10 }, (_, i) => node(`quiet${i}`)),
		];
		const r = focusGraph(nodes, [edge("hub", "h1"), edge("hub", "h2")], 5);
		expect(ids(r)).toEqual(["h1", "h2", "hub", "w1", "w2"]);
	});

	test("keeps the subnet and VPC of every kept node, and no others", () => {
		const nodes = [
			node("seed", { kind: "workload", service: "orders" }),
			node("peer", { kind: "workload" }),
			node("subnet-a", { kind: "subnet" }),
			node("vpc-a", { kind: "vpc" }),
			node("subnet-z", { kind: "subnet" }),
			node("vpc-z", { kind: "vpc" }),
			...Array.from({ length: 10 }, (_, i) => node(`far${i}`, { kind: "workload" })),
		];
		const edges = [
			edge("seed", "peer", "attached-to"),
			edge("seed", "subnet-a", "in-subnet"),
			edge("subnet-a", "vpc-a", "in-vpc"),
			edge("far0", "subnet-z", "in-subnet"),
			edge("subnet-z", "vpc-z", "in-vpc"),
		];
		const r = focusGraph(nodes, edges, 2);
		expect(ids(r)).toEqual(["peer", "seed", "subnet-a", "vpc-a"]);
		expect(r.total).toBe(12); // containers are not counted as drawable
	});
});

describe("collapseDnsRecords", () => {
	const topology = (nodes: NetworkTopology["nodes"], edges: NetworkTopology["edges"]): NetworkTopology => ({
		builtAtTurn: 1,
		sources: ["aws"],
		nodes,
		edges,
	});

	test("records sharing one target become one node carrying the count", () => {
		const t = topology(
			[
				{ id: "lb", kind: "loadBalancer", name: "orders-alb" },
				{ id: "d1", kind: "dnsRecord", name: "a.example.com" },
				{ id: "d2", kind: "dnsRecord", name: "b.example.com" },
				{ id: "d3", kind: "dnsRecord", name: "c.example.com" },
			],
			[
				{ from: "d1", to: "lb", kind: "resolves-to" },
				{ from: "d2", to: "lb", kind: "resolves-to" },
				{ from: "d3", to: "lb", kind: "resolves-to" },
			],
		);
		const r = collapseDnsRecords(t);
		const dns = r.nodes.filter((n) => n.kind === "dnsRecord");
		expect(dns).toEqual([
			{ id: "dns-group:lb", kind: "dnsRecord", name: "a.example.com", recordType: "+2 more records" },
		]);
		expect(r.edges).toEqual([{ from: "dns-group:lb", to: "lb", kind: "resolves-to" }]); // three edges, deduplicated
	});

	test("a record resolving to two targets is left alone, and a lone record is not grouped", () => {
		const t = topology(
			[
				{ id: "lb1", kind: "loadBalancer" },
				{ id: "lb2", kind: "loadBalancer" },
				{ id: "both", kind: "dnsRecord" },
				{ id: "only-lb1", kind: "dnsRecord" },
				{ id: "solo", kind: "dnsRecord" },
			],
			[
				// Without the one-target rule, "both" would join "only-lb1" and form a group of two.
				{ from: "only-lb1", to: "lb1", kind: "resolves-to" },
				{ from: "both", to: "lb1", kind: "resolves-to" },
				{ from: "both", to: "lb2", kind: "resolves-to" },
				{ from: "solo", to: "lb2", kind: "resolves-to" },
			],
		);
		expect(collapseDnsRecords(t)).toBe(t);
	});
});
