// knowledge-graph/src/rebuild.test.ts
import { describe, expect, test } from "bun:test";
import { bindingFromAnnotations, incidentFromAnnotations, parseArgs, rootCauseFromAnnotations } from "./rebuild.ts";
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

// SIO-1103 (4b): mirror-fact mappers.
describe("SIO-1103 rebuild: incidentFromAnnotations", () => {
	test("maps a kg-incident fact, splitting services", () => {
		expect(
			incidentFromAnnotations({
				kind: "kg-incident",
				incident_id: "inc-1",
				services: "orders,payments",
				severity: "high",
			}),
		).toEqual({ id: "inc-1", severity: "high", services: ["orders", "payments"] });
	});
	test("empty services -> []; missing incident_id -> null", () => {
		expect(incidentFromAnnotations({ incident_id: "inc-1", services: "" })).toEqual({
			id: "inc-1",
			severity: "",
			services: [],
		});
		expect(incidentFromAnnotations({ services: "orders" })).toBeNull();
	});
});

describe("SIO-1103 rebuild: rootCauseFromAnnotations", () => {
	test("maps a kg-root-cause fact", () => {
		expect(
			rootCauseFromAnnotations({
				kind: "kg-root-cause",
				incident_id: "inc-1",
				root_cause_id: "rc-hash",
				rule_name: "kafka-significant-lag",
				description: "lag",
				confidence: "0.6",
			}),
		).toEqual({
			id: "rc-hash",
			incidentId: "inc-1",
			class: "kafka-significant-lag",
			description: "lag",
			confidence: 0.6,
			ruleName: "kafka-significant-lag",
		});
	});
	test("missing required field -> null; unparseable confidence -> 0", () => {
		expect(rootCauseFromAnnotations({ incident_id: "inc-1", root_cause_id: "x" })).toBeNull(); // no rule_name
		const rc = rootCauseFromAnnotations({ incident_id: "i", root_cause_id: "x", rule_name: "r" });
		expect(rc?.confidence).toBe(0);
	});
});
