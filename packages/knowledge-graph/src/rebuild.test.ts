// knowledge-graph/src/rebuild.test.ts
import { describe, expect, test } from "bun:test";
import { bindingFromAnnotations, parseArgs } from "./rebuild.ts";
import { InMemoryGraphStore } from "./store.ts";
import { recordServiceBinding } from "./writer.ts";

describe("SIO-1100 rebuild: parseArgs", () => {
	test("parses --out <dir> and --dry-run", () => {
		expect(parseArgs(["--out", ".data/scratch", "--dry-run"])).toEqual({ out: ".data/scratch", dryRun: true });
		expect(parseArgs([])).toEqual({ out: undefined, dryRun: false });
	});

	test("rejects a valueless or flag-shaped --out (would fall back to the live graph)", () => {
		expect(() => parseArgs(["--out"])).toThrow(/--out requires a directory path/);
		expect(() => parseArgs(["--out", "--dry-run"])).toThrow(/--out requires a directory path/);
	});
});

const FULL = {
	kind: "kg-binding",
	service: "orders",
	service_normalized: "order",
	binding_kind: "logGroup",
	resource_id: "/ecs/orders-prd",
	locator: "prod",
	datasource: "aws",
	discovered_by: "resolve-identifiers",
	incident_id: "inc-1",
	confidence: "0.7",
};

describe("SIO-1100 rebuild: bindingFromAnnotations", () => {
	test("maps a full kg-binding fact to a writer record", () => {
		const rec = bindingFromAnnotations(FULL);
		expect(rec).toMatchObject({
			service: "orders",
			serviceNormalized: "order",
			datasource: "aws",
			kind: "logGroup",
			resourceId: "/ecs/orders-prd",
			locator: "prod",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
			incidentId: "inc-1",
		});
	});

	test("returns null on a missing required field", () => {
		expect(bindingFromAnnotations({ ...FULL, service: "" })).toBeNull();
		expect(bindingFromAnnotations({ ...FULL, resource_id: "" })).toBeNull();
		const { datasource: _d, ...noDatasource } = FULL;
		expect(bindingFromAnnotations(noDatasource)).toBeNull();
	});

	test("returns null on an unknown binding kind (poisoned/pre-schema fact)", () => {
		expect(bindingFromAnnotations({ ...FULL, binding_kind: "not-a-kind" })).toBeNull();
	});

	test("falls back to safe defaults for optional/derived fields", () => {
		const rec = bindingFromAnnotations({
			service: "orders",
			binding_kind: "topic",
			resource_id: "orders.events",
			datasource: "kafka",
		});
		expect(rec).toMatchObject({
			serviceNormalized: "orders", // defaults to raw service
			locator: "",
			confidence: 0.7, // default when confidence is unparseable/absent
			discoveredBy: "resolve-identifiers",
		});
	});

	test("replay parity: mapped record writes the same MERGEs as a direct binding", async () => {
		const rec = bindingFromAnnotations(FULL);
		expect(rec).not.toBeNull();
		if (!rec) return;
		const replayed = new InMemoryGraphStore();
		await recordServiceBinding(replayed, rec);
		// same TelemetrySource id + OBSERVED_IN edge a live write would produce
		expect(
			replayed.calls.some(
				(c) => c.cypher.includes("MERGE (t:TelemetrySource") && c.params?.id === "aws:logGroup:/ecs/orders-prd",
			),
		).toBe(true);
		expect(replayed.calls.some((c) => c.cypher.includes("OBSERVED_IN") && c.params?.service === "orders")).toBe(true);
	});
});
