// tests/ftsToolArgs.test.ts
//
// SIO-1823: a scope_name without a bucket_name must fail as a visible argument error.
// Without this guard the tools silently run the CLUSTER-level call instead, and because
// a scoped index is only addressable by its bare name through the scope manager, the
// cluster call fails with IndexNotFoundError -- verified live. The agent would then be
// told the index does not exist when the real fault is a missing argument.

import { describe, expect, test } from "bun:test";
import type { Bucket } from "couchbase";
import { assertScopeArgs } from "../src/lib/ftsIndexes";
import { getFtsIndexDefinition } from "../src/tools/getFtsIndexDefinition";
import { listFtsIndexes } from "../src/tools/listFtsIndexes";
import { runFtsQuery } from "../src/tools/runFtsQuery";
import { parseErrorEnvelope } from "./test.utils";

// Never reached: every case below is rejected before any SDK call. Accessing a property
// throws so a regression that skips the guard fails loudly instead of hitting the network.
const unreachableBucket = new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(`SDK was called (.${String(prop)}) despite invalid arguments`);
		},
	},
) as Bucket;

describe("assertScopeArgs (SIO-1823)", () => {
	test("rejects a scope without a bucket", () => {
		expect(assertScopeArgs(undefined, "styles")).toContain("scope_name requires bucket_name");
	});

	test.each([
		["neither", undefined, undefined],
		["bucket only", "default", undefined],
		["both", "default", "styles"],
	])("accepts %s", (_label, bucketName, scopeName) => {
		expect(assertScopeArgs(bucketName, scopeName)).toBeUndefined();
	});
});

describe("FTS tools reject scope_name without bucket_name (SIO-1823)", () => {
	test("capella_list_fts_indexes", async () => {
		const result = await listFtsIndexes({ scope_name: "styles" }, unreachableBucket);
		expect(result.isError).toBe(true);
		const { _error } = parseErrorEnvelope(result);
		expect(_error.kind).toBe("bad-input");
		expect(_error.message).toContain("scope_name requires bucket_name");
	});

	test("capella_get_fts_index_definition", async () => {
		const result = await getFtsIndexDefinition({ index_name: "i", scope_name: "styles" }, unreachableBucket);
		expect(result.isError).toBe(true);
		expect(parseErrorEnvelope(result)._error.kind).toBe("bad-input");
	});

	test("capella_run_fts_query", async () => {
		const result = await runFtsQuery(
			{ index_name: "i", query: { match_all: {} }, scope_name: "styles" },
			unreachableBucket,
		);
		expect(result.isError).toBe(true);
		expect(parseErrorEnvelope(result)._error.kind).toBe("bad-input");
	});
});
