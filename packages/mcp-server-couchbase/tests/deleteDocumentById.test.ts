// tests/deleteDocumentById.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Bucket, DocumentNotFoundError } from "couchbase";
import { config } from "../src/config";
import { deleteDocument } from "../src/tools/deleteDocumentById";
import { parseErrorEnvelope } from "./test.utils";

function makeBucket(removeImpl: (id: string) => Promise<unknown>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({ remove: removeImpl }),
		}),
	} as unknown as Bucket;
}

// SIO-1109: these tests exercise the WRITE path, now gated on readOnlyQueryMode (default true).
// Save/restore idiom per src/__tests__/tools-list-snapshot.test.ts:61-62,98.
let priorReadOnly: boolean;
beforeEach(() => {
	priorReadOnly = config.server.readOnlyQueryMode;
	config.server.readOnlyQueryMode = false;
});
afterEach(() => {
	config.server.readOnlyQueryMode = priorReadOnly;
});

// SIO-1118: a missing document on delete must surface as a structured not-found
// envelope (kind "not-found" -> category "not-found", non-degrading), not an
// uncaught DocumentNotFoundError that the agent categorizes "unknown" (degrading)
// and uses to cap confidence. Mirrors the SIO-1117 getDocumentById.test.ts pattern.
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

// SIO-1109: delete is the destructive half of the same gap -- read-only mode must refuse it.
describe("deleteDocumentById read-only gate (SIO-1109)", () => {
	test("refuses in read-only mode and performs NO deletion", async () => {
		config.server.readOnlyQueryMode = true;
		let called = false;
		const bucket = makeBucket(async () => {
			called = true;
			return { content: {} };
		});

		const result = await deleteDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "doc-1" },
			bucket,
		);

		expect(result.isError).toBe(true);
		// The load-bearing assertion: refusing but still deleting is the bug wearing a hat.
		expect(called).toBe(false);
		const { _error } = parseErrorEnvelope(result);
		expect(_error.kind).toBe("bad-input");
		expect(_error.category).toBe("bad-query");
		expect(_error.message).toContain("READ_ONLY_QUERY_MODE=false");
	});

	test("deletes normally when read-only mode is disabled", async () => {
		config.server.readOnlyQueryMode = false;
		let called = false;
		const bucket = makeBucket(async () => {
			called = true;
			return { content: {} };
		});

		const result = await deleteDocument(
			{ scope_name: "_default", collection_name: "_default", document_id: "doc-1" },
			bucket,
		);

		expect(result.isError).toBe(false);
		expect(called).toBe(true);
	});
});
