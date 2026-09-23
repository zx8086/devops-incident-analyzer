// apps/web/src/lib/server/archify/to-archify.test.ts
import { describe, expect, test } from "bun:test";
import {
	APPLICATION_FIXTURE,
	NETWORK_FIXTURE,
	REPORTED_APPLICATION_FIXTURE,
	REPORTED_NETWORK_FIXTURE,
} from "./fixtures.ts";
import { renderDiagram } from "./render.ts";
import { type ArchifyArchitecture, applicationToArchify, DIAGRAM_NODE_BUDGET, networkToArchify } from "./to-archify.ts";

function assertWellFormed(diagram: ArchifyArchitecture) {
	const ids = new Set(diagram.components.map((c) => c.id));
	expect(ids.size).toBe(diagram.components.length);
	for (const c of diagram.connections) {
		expect(ids.has(c.from)).toBe(true);
		expect(ids.has(c.to)).toBe(true);
	}
	for (const b of diagram.boundaries ?? []) for (const w of b.wraps) expect(ids.has(w)).toBe(true);
	const cells = diagram.components.map((c) => `${c.row},${c.col}`);
	expect(new Set(cells).size).toBe(cells.length);
}

function assertNoForeignComponentInBoundaries(diagram: ArchifyArchitecture) {
	const cell = new Map(diagram.components.map((c) => [c.id, c]));
	for (const b of diagram.boundaries ?? []) {
		const members = b.wraps.map((w) => cell.get(w)).filter((c) => c !== undefined);
		const rows = members.map((c) => c.row);
		const cols = members.map((c) => c.col);
		const inside = diagram.components.filter(
			(c) =>
				c.row >= Math.min(...rows) &&
				c.row <= Math.max(...rows) &&
				c.col >= Math.min(...cols) &&
				c.col <= Math.max(...cols),
		);
		for (const c of inside) expect(b.wraps).toContain(c.id);
	}
}

describe("networkToArchify", () => {
	const diagram = networkToArchify(NETWORK_FIXTURE);

	test("vpcs and subnets become boundaries, not components", () => {
		assertWellFormed(diagram);
		expect(diagram.components.some((c) => c.id.includes("vpc") || c.id.includes("subnet"))).toBe(false);
		const kinds = (diagram.boundaries ?? []).map((b) => b.kind).sort();
		expect(kinds).toEqual(["region", "region", "security-group", "security-group", "security-group"]);
		const dashed = diagram.connections.filter((c) => c.variant === "dashed");
		expect(dashed).toHaveLength(0); // the only derived edge is in-subnet, which became a wrap
	});

	// A boundary is drawn as its members' bounding box, so any other component inside that box would
	// look like a member. The box spans rows AND columns: a free node beside it (SIO-1878) is fine.
	test("no boundary's bounding box contains another component", () => {
		assertNoForeignComponentInBoundaries(diagram);
	});

	test("renders through the vendored Archify CLI with the hostile name escaped", async () => {
		const result = await renderDiagram("architecture", diagram);
		if (!result.ok) throw new Error(`${result.error}: ${JSON.stringify(result.diagnostics)}`);
		expect(result.html).toContain("<svg");
		expect(result.html).not.toContain('<img src=x onerror="alert(1)">');
	}, 30_000);
});

describe("applicationToArchify", () => {
	const diagram = applicationToArchify(APPLICATION_FIXTURE);

	test("tags unhealthy services and dashes prior-knowledge edges", () => {
		assertWellFormed(diagram);
		const checkout = diagram.components.find((c) => c.label === "checkout-service");
		expect(checkout?.tag).toBe("err 8.0%");
		expect(diagram.components.find((c) => c.label === "payment-service")?.tag).toBeUndefined();
		expect(diagram.connections.filter((c) => c.variant === "dashed")).toHaveLength(1);
	});

	test("renders through the vendored Archify CLI", async () => {
		const result = await renderDiagram("architecture", diagram);
		if (!result.ok) throw new Error(`${result.error}: ${JSON.stringify(result.diagnostics)}`);
		expect(result.html).toContain("<svg");
	}, 30_000);
});

describe("focused, styled output", () => {
	test("uses the signal-flow preset, and says so when a large map is focused down to the budget", async () => {
		const services = Array.from({ length: 40 }, (_, i) => ({
			id: `svc:s${i}`,
			kind: "service" as const,
			name: `s${i}`,
		}));
		const edges = services.slice(1).map((s, i) => ({ from: `svc:s${i}`, to: s.id, kind: "calls" as const }));
		const diagram = applicationToArchify({ ...APPLICATION_FIXTURE, nodes: services, edges });
		expect(diagram.meta.visual_preset).toBe("signal-flow");
		expect(diagram.components).toHaveLength(DIAGRAM_NODE_BUDGET);
		expect(diagram.meta.subtitle).toContain(`${DIAGRAM_NODE_BUDGET} of 40 nodes`);
		expect(applicationToArchify(APPLICATION_FIXTURE).meta.subtitle).toStartWith("6 nodes |");
		const result = await renderDiagram("architecture", diagram);
		if (!result.ok) throw new Error(`${result.error}: ${JSON.stringify(result.diagnostics)}`);
		expect(result.html).toContain('data-preset="signal-flow"');
	}, 30_000);
});

// SIO-1878: the shapes from a user report, and the layout rules that fix them.
describe("layout: compact columns and flow order", () => {
	const columns = (d: ArchifyArchitecture) => {
		const byCol: Record<number, string[]> = {};
		for (const c of d.components) byCol[c.col] = [...(byCol[c.col] ?? []), c.label];
		return byCol;
	};

	test("empty kind bands are dropped: endpoints and workloads are two adjacent columns", () => {
		const d = networkToArchify(REPORTED_NETWORK_FIXTURE);
		expect(Object.keys(columns(d))).toEqual(["0", "1"]);
		expect(d.layout.cols).toBe(2);
		expect(d.connections).toHaveLength(0); // every reported link was containment: boundaries, not edges
		expect(d.boundaries?.length).toBe(4);
		// Unbounded brokers sit beside the VPC block, not stacked below it in a staircase.
		const brokers = d.components.filter((c) => c.label.startsWith("broker"));
		expect(brokers.map((c) => c.row)).toEqual([0, 1, 2]);
		assertNoForeignComponentInBoundaries(d);
	});

	test("columns follow the traffic: entry hosts, then the services they call, then the dependency", () => {
		const byCol = columns(applicationToArchify(REPORTED_APPLICATION_FIXTURE));
		expect(byCol[0]).toEqual(expect.arrayContaining(["orders.example.com:443", "orders-service"]));
		expect(byCol[1]?.sort()).toEqual(["catalog-service", "checkout-service"]);
		expect(byCol[2]).toEqual(["storefront (29 locale..."]);
	});

	test("a call cycle terminates and renders", async () => {
		const svc = (n: string) => ({ id: `svc:${n}`, kind: "service" as const, name: n });
		const d = applicationToArchify({
			...APPLICATION_FIXTURE,
			nodes: [svc("a"), svc("b"), svc("c")],
			edges: [
				{ from: "svc:a", to: "svc:b", kind: "calls" },
				{ from: "svc:b", to: "svc:c", kind: "calls" },
				{ from: "svc:c", to: "svc:a", kind: "calls" },
			],
		});
		// With the back edge skipped, the cycle reads as the chain it was entered by. Without the
		// guard, depths inflate around the loop and the three collapse into two columns.
		const col = new Map(d.components.map((c) => [c.label, c.col]));
		expect([col.get("a"), col.get("b"), col.get("c")]).toEqual([0, 1, 2]);
		const result = await renderDiagram("architecture", d);
		if (!result.ok) throw new Error(`${result.error}: ${JSON.stringify(result.diagnostics)}`);
	}, 30_000);

	test("a deep call chain is scaled into at most 6 columns, keeping its order", () => {
		const services = Array.from({ length: 12 }, (_, i) => ({
			id: `svc:s${i}`,
			kind: "service" as const,
			name: `s${i}`,
		}));
		const edges = services.slice(1).map((s, i) => ({ from: `svc:s${i}`, to: s.id, kind: "calls" as const }));
		const d = applicationToArchify({ ...APPLICATION_FIXTURE, nodes: services, edges });
		const col = new Map(d.components.map((c) => [c.label, c.col]));
		expect(d.layout.cols).toBeLessThanOrEqual(6);
		for (let i = 1; i < 12; i++) expect(col.get(`s${i}`) ?? -1).toBeGreaterThanOrEqual(col.get(`s${i - 1}`) ?? 99);
		expect(col.get("s0")).toBe(0);
		expect(col.get("s11")).toBe(5);
	});
});
