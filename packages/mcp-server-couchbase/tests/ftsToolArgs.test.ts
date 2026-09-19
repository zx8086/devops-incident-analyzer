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

// SIO-1823 (review, PR #852 P1): walking a bucket's scopes swallows per-scope errors so one
// unreadable scope cannot lose the rest. But when EVERY scope fails, the old code returned
// `indexes: []` with isError false -- which the agent cannot distinguish from "this bucket
// has no Search indexes". Reporting absence when the lookup failed is the worse error, and
// it is exactly the shape this repo treats as a defect.
describe("capella_list_fts_indexes bucket-wide enumeration (SIO-1823)", () => {
	// `name` must be set: resolveBucket returns the default bucket only when the requested
	// name matches it, otherwise it reaches for defaultBucket.cluster.bucket(name).
	const bucketWith = (scopes: string[], failing: Set<string>): Bucket =>
		({
			name: "default",
			collections: () => ({ getAllScopes: async () => scopes.map((name) => ({ name })) }),
			scope: (name: string) => ({
				searchIndexes: () => ({
					getAllIndexes: async () => {
						if (failing.has(name)) throw new Error("authorization failed");
						// Shape taken from the live cluster.
						return [
							{
								uuid: "10a9ba93b240b58a",
								name: `${name}Index`,
								sourceName: "default",
								type: "fulltext-index",
							},
						];
					},
				}),
			}),
		}) as unknown as Bucket;

	test("every scope unreadable is an ERROR, not an empty success", async () => {
		const all = new Set(["styles", "styles_stibo"]);
		const result = await listFtsIndexes({ bucket_name: "default" }, bucketWith([...all], all));

		expect(result.isError).toBe(true);
		const { _error } = parseErrorEnvelope(result);
		// server-error, NOT not-found: not-found would assert the indexes are absent, which
		// is precisely the false conclusion this branch exists to prevent.
		expect(_error.kind).toBe("server-error");
		expect(_error.message).toContain("NOT evidence");
	});

	// The other half of the contract: a partial failure must still return what was read,
	// because those indexes are real. Erroring here would lose good data.
	test("a partial failure still returns the readable indexes", async () => {
		const result = await listFtsIndexes(
			{ bucket_name: "default" },
			bucketWith(["styles", "styles_stibo"], new Set(["styles_stibo"])),
		);

		expect(result.isError).toBe(false);
		const body = JSON.parse(result.content[0].text) as {
			indexes: Array<{ name: string }>;
			unreadableScopes: string[];
		};
		expect(body.indexes).toHaveLength(1);
		expect(body.indexes[0].name).toBe("stylesIndex");
		expect(body.unreadableScopes).toEqual(["styles_stibo"]);
	});

	test("a bucket with no Search indexes anywhere is a genuine empty success", async () => {
		const result = await listFtsIndexes({ bucket_name: "default" }, {
			name: "default",
			collections: () => ({ getAllScopes: async () => [{ name: "orders" }] }),
			scope: () => ({ searchIndexes: () => ({ getAllIndexes: async () => [] }) }),
		} as unknown as Bucket);

		expect(result.isError).toBe(false);
		expect((JSON.parse(result.content[0].text) as { indexes: unknown[] }).indexes).toEqual([]);
	});
});
