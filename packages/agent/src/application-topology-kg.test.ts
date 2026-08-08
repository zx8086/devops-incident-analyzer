// agent/src/application-topology-kg.test.ts
import { describe, expect, test } from "bun:test";
import type { ApplicationTopology } from "@devops-agent/shared";
import { deriveApplicationTopology, MAX_EDGES_PER_KIND } from "./application-topology-kg.ts";

function topologyWith(edges: ApplicationTopology["edges"]): ApplicationTopology {
	return { builtAtTurn: 0, sources: ["elastic"], nodes: [], edges };
}

describe("deriveApplicationTopology", () => {
	test("undefined topology derives nothing", () => {
		expect(deriveApplicationTopology(undefined)).toBeUndefined();
	});

	test("maps observed svc->svc calls and cg->topic consumes; strips id prefixes", () => {
		const record = deriveApplicationTopology(
			topologyWith([
				{ from: "svc:checkout-service", to: "svc:payment-service", kind: "calls", detail: "avg 240ms" },
				{ from: "cg:order-workers", to: "topic:orders", kind: "consumes" },
			]),
		);
		expect(record?.dependsOn).toEqual([{ kind: "depends-on", from: "checkout-service", to: "payment-service" }]);
		expect(record?.consumesFrom).toEqual([{ kind: "consumes-from", from: "order-workers", to: "orders" }]);
	});

	test("priorKnowledge overlay edges are NEVER written back", () => {
		const record = deriveApplicationTopology(
			topologyWith([
				{ from: "svc:checkout-service", to: "svc:inventory-service", kind: "calls", priorKnowledge: true },
				{ from: "cg:order-workers", to: "topic:orders", kind: "consumes", priorKnowledge: true },
			]),
		);
		expect(record).toBeUndefined();
	});

	test("dependency and route nodes never become DEPENDS_ON rows; self-edges dropped", () => {
		const record = deriveApplicationTopology(
			topologyWith([
				{ from: "svc:checkout-service", to: "dep:postgresql", kind: "calls" },
				{ from: "route:/api/orders", to: "svc:orders", kind: "calls" },
				{ from: "svc:orders", to: "svc:orders", kind: "calls" },
				{ from: "svc:orders", to: "aws:arn:x", kind: "runs-on" },
			]),
		);
		expect(record).toBeUndefined();
	});

	test("caps each kind at MAX_EDGES_PER_KIND", () => {
		const edges = Array.from({ length: MAX_EDGES_PER_KIND + 10 }, (_, i) => ({
			from: `svc:svc-${i}`,
			to: `svc:svc-${i + 1}`,
			kind: "calls" as const,
		}));
		const record = deriveApplicationTopology(topologyWith(edges));
		expect(record?.dependsOn.length).toBe(MAX_EDGES_PER_KIND);
	});
});
