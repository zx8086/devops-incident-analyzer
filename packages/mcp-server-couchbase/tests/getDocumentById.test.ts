// tests/getDocumentById.test.ts
//
// SIO-1117: regression test -- a missing document must surface as a structured
// not-found envelope (kind "not-found" -> category "not-found", non-degrading),
// not an uncaught DocumentNotFoundError that the agent categorizes "unknown"
// (degrading) and uses to cap confidence.

import { describe, expect, test } from "bun:test";
import { type Bucket, DocumentNotFoundError } from "couchbase";
import { getDocument } from "../src/tools/getDocumentById";

function makeBucket(getImpl: (id: string) => Promise<unknown>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({ get: getImpl }),
		}),
	} as unknown as Bucket;
}

describe("getDocumentById error surfacing (SIO-1117)", () => {
	test("emits a not-found envelope when the document does not exist", async () => {
		const bucket = makeBucket(() => {
			throw new DocumentNotFoundError();
		});

		const result = await getDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "missing-doc" },
			bucket,
		);

		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed._error.kind).toBe("not-found");
		expect(parsed._error.category).toBe("not-found");
	});

	test("returns the document content on a successful get", async () => {
		const doc = { text: "hello", n: 1 };
		const bucket = makeBucket(async () => ({ content: doc }));

		const result = await getDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "doc-1" },
			bucket,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed).toEqual(doc);
	});
});
