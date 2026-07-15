// tests/deleteDocumentById.test.ts
//
// SIO-1118: regression test -- a missing document on delete must surface as a
// structured not-found envelope (kind "not-found" -> category "not-found",
// non-degrading), not an uncaught DocumentNotFoundError that the agent
// categorizes "unknown" (degrading) and uses to cap confidence. Mirrors the
// SIO-1117 getDocumentById.test.ts pattern.

import { describe, expect, test } from "bun:test";
import { type Bucket, DocumentNotFoundError } from "couchbase";
import { deleteDocument } from "../src/tools/deleteDocumentById";

function makeBucket(removeImpl: (id: string) => Promise<unknown>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({ remove: removeImpl }),
		}),
	} as unknown as Bucket;
}

describe("deleteDocumentById error surfacing (SIO-1118)", () => {
	test("emits a not-found envelope when the document does not exist", async () => {
		const bucket = makeBucket(() => {
			throw new DocumentNotFoundError();
		});

		const result = await deleteDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "missing-doc" },
			bucket,
		);

		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed._error.kind).toBe("not-found");
		expect(parsed._error.category).toBe("not-found");
	});

	test("returns a success message on a successful delete", async () => {
		const bucket = makeBucket(async () => ({ content: { id: "doc-1" } }));

		const result = await deleteDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "doc-1" },
			bucket,
		);

		expect(result.isError).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain("successfully deleted");
	});
});
