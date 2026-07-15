// tests/upsertDocumentById.test.ts

import { describe, expect, test } from "bun:test";
import { type Bucket, TimeoutError } from "couchbase";
import { upsertDocument } from "../src/tools/upsertDocumentById";

function makeBucket(upsertImpl: (id: string, content: unknown) => Promise<unknown>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({ upsert: upsertImpl }),
		}),
	} as unknown as Bucket;
}

// SIO-1118: an SDK error on upsert (e.g. a write TimeoutError) or invalid JSON
// content must surface as a structured error envelope with isError:true, not an
// uncaught throw that the agent categorizes "unknown" (degrading) and uses to cap
// confidence. Mirrors the SIO-1117 getDocumentById.test.ts pattern.
describe("upsertDocumentById error surfacing (SIO-1118)", () => {
	test("emits a structured envelope when the SDK upsert fails", async () => {
		const bucket = makeBucket(() => {
			throw new TimeoutError();
		});

		const result = await upsertDocument(
			{
				scope_name: "_default",
				collection_name: "_default",
				document_id: "doc-1",
				document_content: JSON.stringify({ ok: true }),
			},
			bucket,
		);

		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed._error.kind).toBe("timeout");
		expect(parsed._error.category).toBe("transient");
	});

	test("emits an unknown envelope when the document content is invalid JSON", async () => {
		const bucket = makeBucket(async () => ({ content: {} }));

		const result = await upsertDocument(
			{
				scope_name: "_default",
				collection_name: "_default",
				document_id: "doc-1",
				document_content: "not json",
			},
			bucket,
		);

		expect(result.isError).toBe(true);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed._error.kind).toBe("unknown");
		expect(parsed._error.category).toBe("unknown");
	});

	test("returns a success message on a successful upsert", async () => {
		const doc = { text: "hello", n: 1 };
		let stored: unknown;
		const bucket = makeBucket(async (_id, content) => {
			stored = content;
			return { content };
		});

		const result = await upsertDocument(
			{
				scope_name: "_default",
				collection_name: "_default",
				document_id: "doc-1",
				document_content: JSON.stringify(doc),
			},
			bucket,
		);

		expect(result.isError).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain("successfully upserted");
		expect(stored).toEqual(doc);
	});
});
