// tests/getDocumentById.test.ts
//
// SIO-1116: capella_get_document_by_id was the only couchbase tool without a try/catch. A missing
// document threw DocumentNotFoundError uncaught, which the agent's regex classifier tagged
// "unknown" (a DEGRADING category that caps confidence) instead of the routine "not-found" it is.
// Pin the not-found envelope and the happy path.

import { describe, expect, test } from "bun:test";
import { type Bucket, DocumentNotFoundError } from "couchbase";
import { getDocumentById } from "../src/tools/getDocumentById";

function makeBucket(getImpl: (id: string) => Promise<{ content: unknown }>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({
				get: getImpl,
			}),
		}),
	} as unknown as Bucket;
}

const params = { scope_name: "prices", collection_name: "documents", document_id: "PRICE::missing" };

describe("getDocumentById (SIO-1116)", () => {
	test("returns the document content on success", async () => {
		const bucket = makeBucket(async () => ({ content: { id: "PRICE::1", value: 42 } }));
		const result = await getDocumentById({ ...params, document_id: "PRICE::1" }, bucket);
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed).toEqual({ id: "PRICE::1", value: 42 });
	});

	test("a missing document yields a not-found envelope, not an uncaught throw", async () => {
		const bucket = makeBucket(async () => {
			throw new DocumentNotFoundError();
		});
		const result = await getDocumentById(params, bucket);
		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		// category "not-found" is NON-degrading, so it will not cap confidence.
		expect(parsed._error.kind).toBe("not-found");
		expect(parsed._error.category).toBe("not-found");
	});

	test("an unrecognized error still returns a structured envelope (kind 'unknown')", async () => {
		const bucket = makeBucket(async () => {
			throw new Error("some unexpected failure");
		});
		const result = await getDocumentById(params, bucket);
		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed._error.kind).toBe("unknown");
		expect(parsed._error.message).toContain("some unexpected failure");
	});
});
