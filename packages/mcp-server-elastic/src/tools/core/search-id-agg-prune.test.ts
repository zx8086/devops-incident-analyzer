// packages/mcp-server-elastic/src/tools/core/search-id-agg-prune.test.ts
// SIO-1398: `withoutIdFieldAggs` drops aggregations targeting `_id`. Elasticsearch rejects them
// with `illegal_argument_exception: Fielddata access on the _id field is disallowed`, and the
// rejection fails the WHOLE search -- so one bad clause silently takes every valid sibling
// aggregation down with it. Observed live in the mcp-tool-eval elastic leg.

import { describe, expect, test } from "bun:test";
import { withoutIdFieldAggs } from "./search.ts";

describe("withoutIdFieldAggs", () => {
	test("returns undefined when there is nothing to prune (caller skips the rebuild)", () => {
		expect(withoutIdFieldAggs(undefined)).toBeUndefined();
		expect(withoutIdFieldAggs({})).toBeUndefined();
		expect(withoutIdFieldAggs({ by_service: { terms: { field: "service.name", size: 10 } } })).toBeUndefined();
	});

	test("drops the exact shape observed live, keeping valid sibling aggregations", () => {
		// Verbatim from the failing run: a value_count on _id alongside three legitimate terms aggs.
		const pruned = withoutIdFieldAggs({
			error_count: { value_count: { field: "_id" } },
			error_types: { terms: { field: "error.exception.type", size: 20 } },
			message_patterns: { terms: { field: "message.keyword", size: 20 } },
			by_index: { terms: { field: "_index", size: 10 } },
		});

		expect(pruned).toBeDefined();
		// The named aggregation whose only clause was dropped goes away entirely -- an empty
		// aggregation body is itself rejected by ES, so keeping it would swap one bad-query
		// for another.
		expect(Object.keys(pruned ?? {}).sort()).toEqual(["by_index", "error_types", "message_patterns"]);
		expect(JSON.stringify(pruned)).not.toContain('"_id"');
	});

	test.each([["value_count"], ["cardinality"], ["terms"], ["rare_terms"], ["significant_terms"], ["missing"]])(
		"drops a %s clause targeting _id",
		(clause) => {
			const pruned = withoutIdFieldAggs({ n: { [clause]: { field: "_id" } }, keep: { terms: { field: "host" } } });
			expect(Object.keys(pruned ?? {})).toEqual(["keep"]);
		},
	);

	test("leaves _index alone -- only _id is disallowed", () => {
		// _index aggregates fine and is genuinely useful ("which data stream did these land in").
		expect(withoutIdFieldAggs({ by_index: { terms: { field: "_index", size: 10 } } })).toBeUndefined();
	});

	test("does not touch a field merely CONTAINING _id", () => {
		expect(withoutIdFieldAggs({ by_trace: { terms: { field: "trace_id" } } })).toBeUndefined();
		expect(withoutIdFieldAggs({ by_user: { terms: { field: "user._id_hash" } } })).toBeUndefined();
	});

	test("prunes inside a nested sub-aggregation", () => {
		const pruned = withoutIdFieldAggs({
			by_service: {
				terms: { field: "service.name", size: 10 },
				aggs: { doc_ids: { cardinality: { field: "_id" } }, envs: { terms: { field: "service.environment" } } },
			},
		});

		expect(JSON.stringify(pruned)).not.toContain('"_id"');
		// The parent survives with its legitimate sub-aggregation intact.
		expect(JSON.stringify(pruned)).toContain("service.environment");
		expect(JSON.stringify(pruned)).toContain("service.name");
	});

	test("returns an empty object when every aggregation was dropped", () => {
		// The caller treats this as 'omit aggs entirely' rather than sending `{}`, which ES rejects.
		const pruned = withoutIdFieldAggs({ error_count: { value_count: { field: "_id" } } });
		expect(pruned).toEqual({});
	});

	test("leaves a date_histogram untouched (it takes no _id field)", () => {
		expect(
			withoutIdFieldAggs({ over_time: { date_histogram: { field: "@timestamp", calendar_interval: "1h" } } }),
		).toBeUndefined();
	});
});
