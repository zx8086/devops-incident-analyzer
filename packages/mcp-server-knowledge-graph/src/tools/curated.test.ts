// src/tools/curated.test.ts
//
// SIO-967: the curated kg_* tools (promoted from SIO-966's in-process
// runKnowledgeGraphQuery). We drive them through a real Client <-> McpServer round-trip
// over an in-memory transport + InMemoryGraphStore, so registration, schemas, the wire
// shape (tools/call -> content[]), soft-fail wording, and reader wiring are all exercised.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerCuratedTools } from "./curated.ts";

const prevKg = process.env.KNOWLEDGE_GRAPH_ENABLED;

async function connectedClient(): Promise<Client> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerCuratedTools(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
	const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
	const block = res.content[0];
	return block && block.type === "text" ? block.text : JSON.stringify(res.content);
}

beforeEach(() => {
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	if (prevKg === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prevKg;
	_setGraphStoreForTesting(null);
});

describe("curated kg_* tools", () => {
	test("register the four read-only tools", async () => {
		const client = await connectedClient();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"kg_deployment_history",
			"kg_deployments_running_stack",
			"kg_stack_instance_history",
			"kg_stacks_using_module",
		]);
	});

	test("soft-fail when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const out = await call(await connectedClient(), "kg_stacks_using_module", { module: "lifecycle" });
		expect(out).toContain("disabled");
	});

	test("kg_deployments_running_stack renders the reader rows", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("OF_STACK", [{ deployment: "eu-cld" }, { deployment: "us-cld" }]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_deployments_running_stack", { stack: "slos" });
		expect(out).toBe("Deployments running the slos stack: eu-cld, us-cld.");
	});

	test("kg_stacks_using_module renders rows; empty -> friendly message", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		_setGraphStoreForTesting(store);
		expect(await call(await connectedClient(), "kg_stacks_using_module", { module: "lifecycle" })).toBe(
			"Stacks using the lifecycle module: lifecycle-policies.",
		);
		_setGraphStoreForTesting(new InMemoryGraphStore());
		expect(await call(await connectedClient(), "kg_stacks_using_module", { module: "nope" })).toContain(
			"No stacks use",
		);
	});

	test("kg_stack_instance_history renders outcome-tagged lines", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("TARGETS", [
			{ id: "c1", workflow: "slo-edit", summary: "tighten", outcome: "applied", mrUrl: "u9", createdAt: "x" },
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_stack_instance_history", {
			deployment: "eu-cld",
			stack: "slos",
		});
		expect(out).toContain("Recent changes to eu-cld/slos");
		expect(out).toContain("[applied] slo-edit: tighten (u9)");
	});
});
