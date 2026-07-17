// knowledge-graph/src/rebuild.test.ts
import { describe, expect, test } from "bun:test";
import {
	bindingFromAnnotations,
	incidentFromAnnotations,
	invalidatedBindingFromAnnotations,
	parseArgs,
	rootCauseFromAnnotations,
} from "./rebuild.ts";
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
	test("maps a kg-incident fact, splitting services and preserving summary", () => {
		expect(
			incidentFromAnnotations({
				kind: "kg-incident",
				incident_id: "inc-1",
				services: "orders,payments",
				severity: "high",
				summary: "orders failing",
			}),
		).toEqual({ id: "inc-1", severity: "high", summary: "orders failing", services: ["orders", "payments"] });
	});
	test("empty services -> []; missing incident_id -> null", () => {
		expect(incidentFromAnnotations({ incident_id: "inc-1", services: "" })).toEqual({
			id: "inc-1",
			severity: "",
			summary: "",
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

// SIO-1135: the curation-time mirror facts (agent/src/learn/curation-facts.ts) carry EXTRA
// provenance keys (source, ticket) beyond what the rebuild mappers read. This asserts those
// extra keys are ignored and the record maps IDENTICALLY to the canonical shape -- so a
// rebuild-from-facts of a curated store reconstructs the same incidents/root causes. Legacy
// per-run facts (without source/ticket) and curation facts must produce the same record.
describe("SIO-1135 rebuild: curation-fact byte-parity", () => {
	test("kg-incident with curation provenance keys maps like a plain kg-incident", () => {
		const plain = incidentFromAnnotations({
			kind: "kg-incident",
			incident_id: "inc-9",
			services: "orders,payments",
			severity: "high",
			summary: "orders failing",
		});
		const curation = incidentFromAnnotations({
			kind: "kg-incident",
			incident_id: "inc-9",
			services: "orders,payments",
			severity: "high",
			summary: "orders failing",
			source: "curation",
			ticket: "DEVOPS-9",
		});
		expect(curation).toEqual(plain);
		expect(curation).toEqual({
			id: "inc-9",
			severity: "high",
			summary: "orders failing",
			services: ["orders", "payments"],
		});
	});

	test("kg-root-cause with curation provenance keys maps like a plain kg-root-cause", () => {
		const base = {
			kind: "kg-root-cause",
			incident_id: "inc-9",
			root_cause_id: "rc-hash",
			rule_name: "route53-resolver-rule-missing",
			description: "per-VPC resolver rule not associated",
			confidence: "1",
		};
		const plain = rootCauseFromAnnotations(base);
		const curation = rootCauseFromAnnotations({ ...base, source: "curation", ticket: "DEVOPS-9" });
		expect(curation).toEqual(plain);
		expect(curation).toEqual({
			id: "rc-hash",
			incidentId: "inc-9",
			class: "route53-resolver-rule-missing",
			description: "per-VPC resolver rule not associated",
			confidence: 1,
			ruleName: "route53-resolver-rule-missing",
		});
	});
});

// SIO-1127: the kg-binding-invalidated mapper reconstructs the invalidateBindingByHuman args.
describe("SIO-1127 rebuild: invalidatedBindingFromAnnotations", () => {
	test("maps a full kg-binding-invalidated fact", () => {
		expect(
			invalidatedBindingFromAnnotations({
				kind: "kg-binding-invalidated",
				service: "localcore-service",
				service_normalized: "localcoreservice",
				binding_kind: "topic",
				resource_id: "orders.events",
				datasource: "kafka",
				reason: "vestigial config",
				discovered_by: "human",
			}),
		).toEqual({
			service: "localcore-service",
			datasource: "kafka",
			kind: "topic",
			resourceId: "orders.events",
			reason: "vestigial config",
		});
	});

	test("returns null on a missing required field or unknown binding kind", () => {
		const base = { service: "s", binding_kind: "topic", resource_id: "r", datasource: "kafka", reason: "x" };
		expect(invalidatedBindingFromAnnotations(base)).not.toBeNull();
		expect(invalidatedBindingFromAnnotations({ ...base, service: "" })).toBeNull();
		expect(invalidatedBindingFromAnnotations({ ...base, resource_id: "" })).toBeNull();
		expect(invalidatedBindingFromAnnotations({ ...base, binding_kind: "not-a-kind" })).toBeNull();
	});
});
