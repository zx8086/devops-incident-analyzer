// apps/web/src/lib/server/archify/to-archify.test.ts
import { describe, expect, test } from "bun:test";
import { APPLICATION_FIXTURE, NETWORK_FIXTURE } from "./fixtures.ts";
import { renderDiagram } from "./render.ts";
import { type ArchifyArchitecture, applicationToArchify, networkToArchify } from "./to-archify.ts";

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

	// A boundary is drawn as its members' bounding box, so another group's component inside that box
	// would look like a member. Each group must own a contiguous row block.
	test("no boundary's row span contains another group's component", () => {
		const rowOf = new Map(diagram.components.map((c) => [c.id, c.row]));
		for (const b of diagram.boundaries ?? []) {
			const rows = b.wraps.map((w) => rowOf.get(w) ?? -1);
			const [lo, hi] = [Math.min(...rows), Math.max(...rows)];
			const inside = diagram.components.filter((c) => c.row >= lo && c.row <= hi).map((c) => c.id);
			for (const id of inside) expect(b.wraps).toContain(id);
		}
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
