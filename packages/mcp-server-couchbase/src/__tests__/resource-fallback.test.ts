// mcp-server-couchbase/src/__tests__/resource-fallback.test.ts
//
// SIO-1412: regression coverage for readResourceByUri's GENERIC fallback -- the path that
// previously reached into the SDK's private _registeredResources/_registeredResourceTemplates
// fields and broke on an SDK internals change (SIO-1052). It now walks couchbase's own
// ResourceRegistry, populated at registration time. The fast paths (playbook://, docs://) are
// covered end-to-end by factory-replay.test.ts / docs-resolution.test.ts; the four fallback
// schemes below (database://, document://, query://, schema://) were previously untested.
// No mock.module anywhere (process-global, last-wins).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Bucket } from "couchbase";
import { config } from "../config";
import { registerAllResources } from "../resources/index.ts";
import { ResourceRegistry } from "../resources/resource-registry.ts";
import { buildReadResourceByUri } from "../server.ts";

// Registration never touches the bucket (handlers run only on read), so the stub only
// needs the calls the exercised handlers make: getAllScopes, scope().query, collection().get.
const stubBucket = {
	name: "test-bucket",
	collections: () => ({
		getAllScopes: async () => [{ name: "inventory", collections: [{ name: "products" }] }],
	}),
	scope: (_scope: string) => ({
		query: async (_q: string) => ({ rows: [] as string[] }),
		collection: (_c: string) => ({
			get: async (_id: string) => ({ content: { sku: "WIDGET-1", stock: 3 } }),
		}),
	}),
} as unknown as Bucket;

function textOf(result: unknown): string {
	const contents = (result as { contents?: Array<{ text?: string }> }).contents ?? [];
	return contents.map((c) => c.text ?? "").join("\n");
}

let readResourceByUri: (uri: string) => Promise<unknown>;
let priorDocumentation: typeof config.documentation;

beforeAll(() => {
	// Docs are irrelevant here (their fast path is covered by docs-resolution.test.ts);
	// pin them off so .env leakage cannot change which resources register.
	priorDocumentation = config.documentation;
	config.documentation = { enabled: false, baseDirectory: "./docs", fileExtension: ".md" };

	// Production composition: the same registerAllResources + buildReadResourceByUri wiring
	// server.ts uses inside createMcpServerFactory (minus the factory recording, which
	// factory-replay.test.ts covers). playbooks: null exercises the pure fallback route.
	const server = new McpServer({ name: "couchbase-resource-fallback-test", version: "0.0.0" });
	const registry = new ResourceRegistry();
	const docsHandler = registerAllResources(server, stubBucket, null, registry);
	readResourceByUri = buildReadResourceByUri({ bucket: stubBucket, playbooks: null }, docsHandler, registry);
});

afterAll(() => {
	config.documentation = priorDocumentation;
});

describe("readResourceByUri generic fallback via the own ResourceRegistry (SIO-1412)", () => {
	test("database://structure dispatches to the exact-URI handler and renders the structure", async () => {
		const result = await readResourceByUri("database://structure");
		const text = textOf(result);
		expect(text).toContain("Couchbase Database Structure");
		expect(text).toContain("inventory");
		expect(text).toContain("products");
	});

	test("document://{scope}/{collection}/{id} template-matches and returns the document content", async () => {
		const result = await readResourceByUri("document://inventory/products/widget-1");
		const text = textOf(result);
		expect(text).toContain("WIDGET-1");
	});

	test("query://{scope}/{encodedQuery} template-matches and executes the decoded SELECT", async () => {
		const result = await readResourceByUri(`query://inventory/${encodeURIComponent("SELECT * FROM products")}`);
		const text = textOf(result);
		// The stub returns zero rows; a successful dispatch serializes them as JSON ("[]").
		// A missed dispatch would have thrown McpError before reaching the handler.
		expect(text).toContain("[]");
	});

	test("schema://{scope}/{collection} template-matches and reaches the schema handler", async () => {
		const result = await readResourceByUri("schema://inventory/products");
		const text = textOf(result);
		// Zero rows from the stub query -> the handler's own "no documents" response,
		// proving the template matched and the real handler ran.
		expect(text).toContain("No documents found in inventory.products");
	});

	test("unknown scheme throws McpError InvalidParams (SDK resources/read parity)", async () => {
		let thrown: unknown;
		try {
			await readResourceByUri("unknown://nothing-registered-here");
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(McpError);
		expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
		expect((thrown as McpError).message).toContain("No resource handler found for URI");
	});
});

describe("scheme-less documentation URIs resolve via the registry (SIO-1412, CodeRabbit)", () => {
	// The three placeholder docs resources register under SCHEME-LESS URIs; a bare
	// new URL() would throw TypeError before their handlers run. The registry's
	// base-URL fallback must carry them through to a real response.
	test("scope-documentation / collection-documentation / documentation-file return responses, not TypeError", async () => {
		const prior = config.documentation;
		config.documentation = { enabled: true, baseDirectory: "./docs-fixture-unused", fileExtension: ".md" };
		try {
			const server = new McpServer({ name: "couchbase-schemeless-docs-test", version: "0.0.0" });
			const registry = new ResourceRegistry();
			const docsHandler = registerAllResources(server, stubBucket, null, registry);
			const read = buildReadResourceByUri({ bucket: stubBucket, playbooks: null }, docsHandler, registry);

			const scopeDoc = await read("scope-documentation");
			expect(textOf(scopeDoc)).toContain("Scope Documentation");

			const collectionDoc = await read("collection-documentation");
			expect(textOf(collectionDoc).length).toBeGreaterThan(0);

			const fileDoc = await read("documentation-file");
			expect(textOf(fileDoc).length).toBeGreaterThan(0);
		} finally {
			config.documentation = prior;
		}
	});
});
