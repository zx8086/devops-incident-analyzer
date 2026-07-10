// mcp-server-couchbase/src/__tests__/docs-resolution.test.ts
//
// SIO-1052: positive-assertion regression tests for the docs:// documentation tools. The old
// readResourceByUri registry walk used field names that never existed on SDK 1.29 internals, so
// capella_list_documentation / capella_read_documentation always errored with "No resource handler
// found" -- and the earlier substring-absence assertions could not catch it. These tests drive the
// tools end-to-end through a REPLAYED server (cached factory) and assert real content is returned.
// No mock.module anywhere (process-global, last-wins -- see local-tools.test.ts in packages/agent).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { config } from "../config";
import { PlaybookHandler, type PlaybookRegistry } from "../resources/playbookResource.ts";
import { createMcpServerFactory } from "../server.ts";

const stubBucket = {} as unknown as Bucket;

function makePlaybooks(): PlaybookRegistry {
	const handler = new PlaybookHandler("/fake/playbook/dir", ".md");
	handler.playbookFiles = ["test1.md"];
	return { handler, resourceIds: ["test1"] };
}

async function connectedClient(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "couchbase-docs-resolution-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

let docsDir: string;
let priorDocumentation: typeof config.documentation;

beforeAll(async () => {
	// Fixture docs tree: one scope dir containing one collection dir, so listDocumentation
	// renders both names. Distinctive names avoid collisions with any real ./docs content.
	docsDir = await fs.mkdtemp(path.join(os.tmpdir(), "sio1052-docs-"));
	await fs.mkdir(path.join(docsDir, "inventory-fixture", "products-fixture"), { recursive: true });
	priorDocumentation = config.documentation;
	config.documentation = { enabled: true, baseDirectory: docsDir, fileExtension: ".md" };
});

afterAll(async () => {
	config.documentation = priorDocumentation;
	await fs.rm(docsDir, { recursive: true, force: true });
});

describe("docs:// resolution through a replayed server (SIO-1052)", () => {
	test("capella_list_documentation (root) returns the real documentation browser content", async () => {
		const factory = createMcpServerFactory({ bucket: stubBucket, playbooks: makePlaybooks() });
		const client = await connectedClient(factory());
		const result = (await client.callTool({ name: "capella_list_documentation", arguments: {} })) as {
			isError?: boolean;
			content?: Array<{ type: string; text?: string }>;
		};
		expect(result.isError).not.toBe(true);
		const text = textOf(result);
		expect(text).toContain("Documentation Browser");
		expect(text).toContain("inventory-fixture");
		expect(text).toContain("products-fixture");
		expect(text).not.toContain("No resource handler found");
	});

	test("capella_list_documentation (scoped) returns scope documentation, not an error", async () => {
		const factory = createMcpServerFactory({ bucket: stubBucket, playbooks: makePlaybooks() });
		const client = await connectedClient(factory());
		const result = (await client.callTool({
			name: "capella_list_documentation",
			arguments: { scope_name: "inventory-fixture" },
		})) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
		expect(result.isError).not.toBe(true);
		const text = textOf(result);
		expect(text).toContain("Scope Documentation");
		expect(text).toContain("inventory-fixture");
	});

	test("capella_read_documentation returns collection/file documentation content", async () => {
		const factory = createMcpServerFactory({ bucket: stubBucket, playbooks: makePlaybooks() });
		const client = await connectedClient(factory());
		const result = (await client.callTool({
			name: "capella_read_documentation",
			arguments: {
				scope_name: "inventory-fixture",
				collection_name: "products-fixture",
				file_name: "overview",
			},
		})) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
		expect(result.isError).not.toBe(true);
		const text = textOf(result);
		expect(text).toContain("Documentation File");
		expect(text).toContain("products-fixture");
	});

	test("docs resolution is identical across two replayed servers from the same factory", async () => {
		const factory = createMcpServerFactory({ bucket: stubBucket, playbooks: makePlaybooks() });
		const texts: string[] = [];
		for (const server of [factory(), factory()]) {
			const client = await connectedClient(server);
			const result = (await client.callTool({ name: "capella_list_documentation", arguments: {} })) as {
				content?: Array<{ type: string; text?: string }>;
			};
			texts.push(textOf(result));
		}
		expect(texts[0]).toBe(texts[1]);
		expect(texts[0]).toContain("inventory-fixture");
	});
});
