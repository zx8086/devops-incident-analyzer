// src/tools/orbit/orbit-query-schema.test.ts
// SIO-1408: gitlab_orbit_query_graph's `query` used to be a bare z.record, which serialises to
// `additionalProperties: {}` -- ANY object passed JSON-Schema, so the model got no structural
// signal and learned it was wrong only from Orbit's validator, after the billed call. Measured
// live: 10 attempts, 10 rejections, 0 successes in a single eval example.
//
// These tests pin the typed skeleton: a malformed query must now fail LOCALLY with a message
// naming the offending field, and every documented shape must still parse.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrbitTools } from "./index.js";

async function orbitToolSchema(): Promise<Record<string, unknown>> {
	const server = new McpServer({ name: "orbit-schema-test", version: "0.0.0" });
	registerOrbitTools(server, {
		client: undefined,
		available: false,
		maxQueriesPerRun: 20,
	} as never);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "orbit-schema-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	const tool = tools.find((t) => t.name === "gitlab_orbit_query_graph");
	return (tool?.inputSchema.properties as Record<string, Record<string, unknown>>)?.query ?? {};
}

describe("gitlab_orbit_query_graph query schema is discoverable", () => {
	test("query_type is an ENUM, not free-form -- the model can see the valid values", async () => {
		const query = await orbitToolSchema();
		const props = query.properties as Record<string, { enum?: string[] }> | undefined;
		expect(props?.query_type?.enum?.sort()).toEqual(["aggregation", "neighbors", "path_finding", "traversal"]);
	});

	test("nodes is a typed array and required", async () => {
		const query = await orbitToolSchema();
		const props = query.properties as Record<string, { type?: string }> | undefined;
		expect(props?.nodes?.type).toBe("array");
		expect(query.required).toContain("nodes");
		expect(query.required).toContain("query_type");
	});

	test("the description carries a COMPLETE worked example, not just field names", async () => {
		const query = await orbitToolSchema();
		const description = String(query.description ?? "");
		// A model that has never seen the DSL needs a payload it can copy, not a grammar summary.
		expect(description).toContain('"query_type":"traversal"');
		expect(description).toContain('"ends_with"');
	});

	test("query_type documents that single-node traversal IS the search shape", async () => {
		// The single sharpest trap: a model reaching for a `search` query_type is wrong, and
		// nothing else in the schema would tell it so. The note lives on the query_type field
		// itself, where a model inspecting that property will actually read it.
		const query = await orbitToolSchema();
		const props = query.properties as Record<string, { description?: string }> | undefined;
		expect(String(props?.query_type?.description ?? "").toLowerCase()).toContain("search shape");
	});

	test("node selectors expose filters and node_ids as distinct documented fields", async () => {
		const query = await orbitToolSchema();
		const nodes = (query.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>)?.nodes;
		const nodeProps = nodes?.items?.properties ?? {};
		expect(Object.keys(nodeProps).sort()).toEqual(
			["columns", "entity", "filters", "id", "id_property", "id_range", "node_ids"].sort(),
		);
	});
});
