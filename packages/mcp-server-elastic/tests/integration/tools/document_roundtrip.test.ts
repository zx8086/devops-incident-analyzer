// tests/integration/tools/document_roundtrip.test.ts
//
// SIO-659: verify that get_document and multi_get return _source verbatim when
// the caller doesn't pass the source option. The bug was that booleanField()
// defaulted to false, so undefined params.source became _source=false on the
// wire and ES correctly stripped the body.
//
// No mocks. Hits ELASTIC_GL_TESTING_URL directly. Skips cleanly if gl-testing
// credentials aren't in the environment (so fork CI without .env doesn't fail).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@elastic/elasticsearch";
import { HttpConnection } from "@elastic/transport";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMultiGetTool } from "../../../src/tools/bulk/multi_get.js";
import { registerGetDocumentTool } from "../../../src/tools/document/get_document.js";
import { registerIndexDocumentTool } from "../../../src/tools/document/index_document.js";
import { initializeReadOnlyManager } from "../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

const TEST_URL = Bun.env.ELASTIC_GL_TESTING_URL;
const TEST_KEY = Bun.env.ELASTIC_GL_TESTING_API_KEY;
const CAN_RUN = Boolean(TEST_URL && TEST_KEY);

// Skip the whole suite if gl-testing isn't wired. Use describe.skipIf so the
// skip is reflected clearly in test output rather than silently missing.
const describeIf = CAN_RUN ? describe : describe.skip;

describeIf("SIO-659 document round-trip (integration, gl-testing)", () => {
	const INDEX = `sio659-int-${Date.now()}`;
	const BODY = { field_a: "value", nested: { n: 42, msg: "hello" }, arr: [1, 2, 3] };
	let client: Client;
	let indexHandler: (args: any) => Promise<any>;
	let getHandler: (args: any) => Promise<any>;
	let mgetHandler: (args: any) => Promise<any>;
	let createdId: string;

	beforeAll(async () => {
		initializeReadOnlyManager(false, false);
		client = new Client({
			node: TEST_URL as string,
			auth: { apiKey: TEST_KEY as string },
			Connection: HttpConnection,
			headers: { Accept: "application/json", "Content-Type": "application/json" },
		});

		const server = new McpServer({ name: "sio659-int", version: "0.0.0" });
		registerIndexDocumentTool(server, client);
		registerGetDocumentTool(server, client);
		registerMultiGetTool(server, client);
		indexHandler = getToolFromServer(server, "elasticsearch_index_document")?.handler as any;
		getHandler = getToolFromServer(server, "elasticsearch_get_document")?.handler as any;
		mgetHandler = getToolFromServer(server, "elasticsearch_multi_get")?.handler as any;

		await client.indices.create({ index: INDEX });
	});

	afterAll(async () => {
		try {
			await client.indices.delete({ index: INDEX });
		} catch {}
		await client.close();
	});

	test("get_document returns _source when caller omits the source option (regression of the original bug)", async () => {
		// Index a doc, wait for it to be visible, then get it back.
		const indexResp = await indexHandler({ index: INDEX, document: BODY });
		const indexBody = JSON.parse(indexResp.content[0].text);
		createdId = indexBody._id;
		await client.indices.refresh({ index: INDEX });

		const getResp = await getHandler({ index: INDEX, id: createdId });
		const gotBody = JSON.parse(getResp.content[0].text);

		expect(gotBody.found).toBe(true);
		expect(gotBody._source).toEqual(BODY);
	});

	test("get_document with source:true still returns _source", async () => {
		const getResp = await getHandler({ index: INDEX, id: createdId, source: true });
		const gotBody = JSON.parse(getResp.content[0].text);
		expect(gotBody._source).toEqual(BODY);
	});

	test("get_document with source:false explicitly opts out of _source (behaviour preserved)", async () => {
		const getResp = await getHandler({ index: INDEX, id: createdId, source: false });
		const gotBody = JSON.parse(getResp.content[0].text);
		expect(gotBody.found).toBe(true);
		expect(gotBody._source).toBeUndefined();
	});

	test("get_document with sourceIncludes filters to the requested field", async () => {
		const getResp = await getHandler({
			index: INDEX,
			id: createdId,
			sourceIncludes: ["field_a"],
		});
		const gotBody = JSON.parse(getResp.content[0].text);
		expect(gotBody._source).toEqual({ field_a: "value" });
	});

	test("multi_get returns _source for every doc when caller omits the source option", async () => {
		// Seed two more docs so mget has something to return.
		const r1 = await indexHandler({ index: INDEX, document: { tag: "a", x: 1 } });
		const id1 = JSON.parse(r1.content[0].text)._id;
		const r2 = await indexHandler({ index: INDEX, document: { tag: "b", x: 2 } });
		const id2 = JSON.parse(r2.content[0].text)._id;
		await client.indices.refresh({ index: INDEX });

		const mgetResp = await mgetHandler({
			docs: [
				{ _index: INDEX, _id: id1 },
				{ _index: INDEX, _id: id2 },
			],
		});
		const body = JSON.parse(mgetResp.content[0].text);
		expect(body.docs).toHaveLength(2);
		expect(body.docs[0]._source).toEqual({ tag: "a", x: 1 });
		expect(body.docs[1]._source).toEqual({ tag: "b", x: 2 });
	});
});

// When gl-testing isn't available, record a visible placeholder rather than
// staying completely silent — makes CI logs unambiguous about what was skipped.
if (!CAN_RUN) {
	describe("SIO-659 document round-trip (integration, gl-testing)", () => {
		test.skip("skipped: ELASTIC_GL_TESTING_URL and ELASTIC_GL_TESTING_API_KEY not set", () => {});
	});
}
