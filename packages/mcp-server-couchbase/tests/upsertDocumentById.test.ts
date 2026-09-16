// tests/upsertDocumentById.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Bucket, TimeoutError } from "couchbase";
import { config } from "../src/config";
import { upsertDocument } from "../src/tools/upsertDocumentById";
import { parseErrorEnvelope } from "./test.utils";

function makeBucket(upsertImpl: (id: string, content: unknown) => Promise<unknown>): Bucket {
	return {
		scope: (_scope: string) => ({
			collection: (_collection: string) => ({ upsert: upsertImpl }),
		}),
	} as unknown as Bucket;
}

// SIO-1109: these tests exercise the WRITE path, which is now gated on readOnlyQueryMode
// (default true). Flip the flag around each one -- direct config mutation with a save/restore
// is the established idiom here (src/__tests__/tools-list-snapshot.test.ts:61-62,98); the repo
// avoids mock.module because it is process-global and last-wins.
let priorReadOnly: boolean;
beforeEach(() => {
	priorReadOnly = config.server.readOnlyQueryMode;
	config.server.readOnlyQueryMode = false;
});
afterEach(() => {
	config.server.readOnlyQueryMode = priorReadOnly;
});

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

// SIO-1109: READ_ONLY_QUERY_MODE (default true) was enforced only on the SQL++ path, so KV
// writes mutated a server configured read-only.
describe("upsertDocumentById read-only gate (SIO-1109)", () => {
	test("refuses in read-only mode and performs NO mutation", async () => {
		config.server.readOnlyQueryMode = true;
		let called = false;
		const bucket = makeBucket(async (_id, content) => {
			called = true;
			return { content };
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
		// The load-bearing assertion: a gate that refuses but still writes is the bug wearing a hat.
		expect(called).toBe(false);
		const { _error } = parseErrorEnvelope(result);
		// bad-input -> category bad-query, which is NON-degrading (shared/src/agent-state.ts:107-111).
		// auth-denied would map to "auth" and cap subagent confidence for a correct policy refusal.
		expect(_error.kind).toBe("bad-input");
		expect(_error.category).toBe("bad-query");
		expect(_error.message).toContain("READ_ONLY_QUERY_MODE=false");
	});

	test("writes normally when read-only mode is disabled", async () => {
		config.server.readOnlyQueryMode = false;
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
				document_content: JSON.stringify({ ok: true }),
			},
			bucket,
		);

		expect(result.isError).toBe(false);
		expect(stored).toEqual({ ok: true });
	});
});
