// packages/agent/src/resolve-identifiers-parsers.test.ts

import { describe, expect, test } from "bun:test";
import {
	parseAtlassianProjects,
	parseAtlassianSpaces,
	parseAwsEcsServiceArns,
	parseAwsLogGroups,
	parseCouchbaseScopeTree,
	parseCouchbaseSystemIndexes,
	parseElasticServiceAgg,
	parseGitlabProjects,
	parseKafkaConsumerGroups,
	parseKafkaTopics,
	parseKonnectControlPlanes,
	parseKonnectServices,
} from "./resolve-identifiers-parsers.ts";

describe("parseElasticServiceAgg", () => {
	// The real shape: a leading text line joined to the aggregations JSON.
	const NORMALIZED = [
		"Search results with aggregations (17800000 total hits, 42ms):",
		JSON.stringify({
			by_service: {
				buckets: [
					{ key: "pvh-services-orders", doc_count: 17800000 },
					{ key: "orders", doc_count: 42 },
				],
			},
		}),
	].join("\n\n");

	test("extracts service.name bucket keys from the two-block agg text", () => {
		expect(parseElasticServiceAgg(NORMALIZED)).toEqual(["pvh-services-orders", "orders"]);
	});

	test("handles nested aggs", () => {
		const nested = JSON.stringify({ outer: { inner: { buckets: [{ key: "svc-a" }] } } });
		expect(parseElasticServiceAgg(nested)).toEqual(["svc-a"]);
	});

	test("returns [] on missing aggregations / malformed JSON / leading-text-only", () => {
		expect(parseElasticServiceAgg("Search results with aggregations (0 total hits):")).toEqual([]);
		expect(parseElasticServiceAgg("{not json")).toEqual([]);
		expect(parseElasticServiceAgg(JSON.stringify({ by_service: {} }))).toEqual([]);
	});

	test("dedupes repeated keys", () => {
		const dup = JSON.stringify({ a: { buckets: [{ key: "x" }] }, b: { buckets: [{ key: "x" }] } });
		expect(parseElasticServiceAgg(dup)).toEqual(["x"]);
	});
});

describe("parseCouchbaseScopeTree", () => {
	const TREE = [
		"Here are all the scopes and collections in the bucket:",
		"",
		"📁 Scope: new_model",
		"  └─ 📄 Collection: seasonal_assignment",
		"  └─ 📄 Collection: brands_divisions",
		"",
		"📁 Scope: _default",
		"  └─ (No collections)",
		"",
	].join("\n");

	test("parses scopes and their collections", () => {
		expect(parseCouchbaseScopeTree(TREE)).toEqual({
			new_model: ["seasonal_assignment", "brands_divisions"],
			_default: [],
		});
	});

	test("(No collections) yields an empty array, not a bogus collection", () => {
		const result = parseCouchbaseScopeTree(TREE);
		expect(result._default).toEqual([]);
	});

	test("tolerates missing emoji / extra whitespace", () => {
		const plain = "Scope: orders\n   Collection: order_lines\nScope: inventory\n  Collection:  stock  ";
		expect(parseCouchbaseScopeTree(plain)).toEqual({ orders: ["order_lines"], inventory: ["stock"] });
	});

	test("returns {} on empty input", () => {
		expect(parseCouchbaseScopeTree("")).toEqual({});
	});
});

describe("parseCouchbaseSystemIndexes (SIO-1088: primary vs secondary + key fields)", () => {
	// Fixture rows mirror the LIVE system:indexes shape validated against the prana cluster:
	// backtick-wrapped index_key fields, is_primary boolean, function-expr keys, deferred state.
	function md(rows: unknown[]): string {
		return `# System Indexes (${rows.length} results)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n\n## Query Execution Details`;
	}

	test("secondary-only collection: hasPrimary=false, extracts plain key fields, drops function exprs", () => {
		const out = parseCouchbaseSystemIndexes(
			md([
				{
					scope_id: "seasons",
					keyspace_id: "dates",
					state: "online",
					name: "idx_fms",
					index_key: ["`styleSeasonCodeFms`", "`divisionCode`", "`salesOrganizationCode`", "`articleType`"],
				},
				{
					scope_id: "seasons",
					keyspace_id: "dates",
					state: "online",
					name: "idx_concat",
					index_key: ["`salesOrganizationCode`", 'concat2("_", `a`, `b`)', "`sapIdentifier`"],
				},
			]),
		);
		expect(out.seasons?.dates?.hasPrimary).toBe(false);
		// deduped, first-seen order, function expr concat2(...) dropped
		expect(out.seasons?.dates?.secondaryKeyFields).toEqual([
			"styleSeasonCodeFms",
			"divisionCode",
			"salesOrganizationCode",
			"articleType",
			"sapIdentifier",
		]);
	});

	test("preserves backtick-wrapped field names with hyphens / leading digits; drops only function exprs", () => {
		const out = parseCouchbaseSystemIndexes(
			md([
				{
					scope_id: "s",
					keyspace_id: "c",
					state: "online",
					name: "idx",
					// a hyphenated field, a leading-digit field, a plain field, and a function expr
					index_key: ["`order-id`", "`2ndKey`", "`plainField`", 'concat2("_", `a`, `b`)'],
				},
			]),
		);
		expect(out.s?.c?.secondaryKeyFields).toEqual(["order-id", "2ndKey", "plainField"]);
	});

	test("primary index sets hasPrimary=true", () => {
		const out = parseCouchbaseSystemIndexes(
			md([
				{
					scope_id: "new_model",
					keyspace_id: "seasonal_assignment",
					state: "online",
					is_primary: true,
					name: "#primary",
				},
			]),
		);
		expect(out.new_model?.seasonal_assignment?.hasPrimary).toBe(true);
	});

	test("deferred (not online) indexes are ignored", () => {
		const out = parseCouchbaseSystemIndexes(
			md([{ scope_id: "seasons", keyspace_id: "building", state: "deferred", index_key: ["`x`"] }]),
		);
		expect(out.seasons?.building).toBeUndefined();
	});

	test("bucket-level primary (scope_id null) is skipped", () => {
		const out = parseCouchbaseSystemIndexes(
			md([{ scope_id: null, keyspace_id: "default", state: "online", is_primary: true, name: "#primary" }]),
		);
		expect(Object.keys(out)).toHaveLength(0);
	});

	test("returns {} on empty / malformed input", () => {
		expect(parseCouchbaseSystemIndexes("")).toEqual({});
		expect(parseCouchbaseSystemIndexes("no json here")).toEqual({});
	});
});

describe("parseAwsLogGroups", () => {
	test("lifts logGroupName from a normal payload", () => {
		const json = { logGroups: [{ logGroupName: "/ecs/order-service" }, { logGroupName: "/aws/lambda/order-worker" }] };
		expect(parseAwsLogGroups(json)).toEqual({ logGroups: ["/ecs/order-service", "/aws/lambda/order-worker"] });
	});

	test("returns the error kind on an _error payload (no crash)", () => {
		expect(parseAwsLogGroups({ _error: { kind: "iam-permission-missing" } })).toEqual({
			logGroups: [],
			error: "iam-permission-missing",
		});
	});

	test("returns [] for empty / malformed", () => {
		expect(parseAwsLogGroups({ logGroups: [] })).toEqual({ logGroups: [] });
		expect(parseAwsLogGroups(null)).toEqual({ logGroups: [] });
	});
});

describe("parseAwsEcsServiceArns", () => {
	test("returns the service name (last ARN segment)", () => {
		const json = {
			serviceArns: [
				"arn:aws:ecs:eu-west-1:1:service/eu-oit-prd/order-service",
				"arn:aws:ecs:eu-west-1:1:service/eu-oit-prd/localcore-service",
			],
		};
		expect(parseAwsEcsServiceArns(json)).toEqual(["order-service", "localcore-service"]);
	});

	test("returns [] on missing/malformed serviceArns", () => {
		expect(parseAwsEcsServiceArns({})).toEqual([]);
		expect(parseAwsEcsServiceArns(null)).toEqual([]);
	});
});

describe("parseKafkaTopics", () => {
	test("lifts topic names from { topics: [{ name }] }", () => {
		const json = { topics: [{ name: "orders.v1" }, { name: "orders.dlq" }], total: 2 };
		expect(parseKafkaTopics(json)).toEqual(["orders.v1", "orders.dlq"]);
	});

	test("returns [] on missing topics", () => {
		expect(parseKafkaTopics({})).toEqual([]);
	});
});

describe("parseKafkaConsumerGroups", () => {
	test("lifts group ids from an array of { id, state }", () => {
		const json = [
			{ id: "orders-service-prd", state: "Stable" },
			{ id: "orders-service-stg", state: "Empty" },
		];
		expect(parseKafkaConsumerGroups(json)).toEqual(["orders-service-prd", "orders-service-stg"]);
	});

	test("returns [] when not an array", () => {
		expect(parseKafkaConsumerGroups({ groups: [] })).toEqual([]);
	});
});

describe("parseKonnect*", () => {
	test("control planes -> { controlPlaneId, name }", () => {
		const json = { controlPlanes: [{ controlPlaneId: "cp-1", name: "orders-cp" }] };
		expect(parseKonnectControlPlanes(json)).toEqual([{ controlPlaneId: "cp-1", name: "orders-cp" }]);
	});

	test("services -> { serviceId, name }", () => {
		const json = { services: [{ serviceId: "svc-1", name: "orders" }] };
		expect(parseKonnectServices(json)).toEqual([{ serviceId: "svc-1", name: "orders" }]);
	});

	test("empty on shape drift", () => {
		expect(parseKonnectControlPlanes({})).toEqual([]);
		expect(parseKonnectServices(null)).toEqual([]);
	});
});

describe("parseGitlabProjects (lift numeric id)", () => {
	test("carries the numeric id as a string plus path", () => {
		const json = [
			{ id: 41051769, name: "order-service", path_with_namespace: "pvhcorp/b2b/oit/order-service" },
			{ id: 999, name: "unrelated" },
		];
		expect(parseGitlabProjects(json)).toEqual([
			{ id: "41051769", name: "order-service", pathWithNamespace: "pvhcorp/b2b/oit/order-service" },
			{ id: "999", name: "unrelated", pathWithNamespace: undefined },
		]);
	});

	test("skips rows without an id; returns [] for non-array", () => {
		expect(parseGitlabProjects([{ name: "x" }])).toEqual([]);
		expect(parseGitlabProjects({})).toEqual([]);
	});
});

describe("parseAtlassian*", () => {
	test("projects: bare array keyed on `key`", () => {
		const json = [
			{ key: "OIT", name: "OIT Incidents" },
			{ key: "B2B", name: "B2B" },
		];
		expect(parseAtlassianProjects(json)).toEqual([
			{ key: "OIT", name: "OIT Incidents" },
			{ key: "B2B", name: "B2B" },
		]);
	});

	test("projects: { values: [] } wrapper", () => {
		expect(parseAtlassianProjects({ values: [{ key: "OIT" }] })).toEqual([{ key: "OIT", name: undefined }]);
	});

	test("spaces: { results: [] } wrapper", () => {
		expect(parseAtlassianSpaces({ results: [{ key: "RUN", name: "Runbooks" }] })).toEqual([
			{ key: "RUN", name: "Runbooks" },
		]);
	});
});
