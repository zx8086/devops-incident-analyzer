// src/tools/curated.test.ts
//
// SIO-967/SIO-968: the curated kg_* tools. Driven through a real Client <-> McpServer
// round-trip over an in-memory transport + InMemoryGraphStore, so registration, schemas,
// the wire shape (tools/call -> content[]), the loud-fail wording, and reader wiring are
// all exercised. SIO-968: the enabled gate is the registration ARG (the server's startup
// config), NOT a per-call process.env read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerCuratedTools } from "./curated.ts";

async function connectedClient(enabled = true): Promise<Client> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerCuratedTools(server, enabled);
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
	_setGraphStoreForTesting(null);
});

describe("curated kg_* tools", () => {
	test("register the read-only tools", async () => {
		const client = await connectedClient();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"kg_deployment_history",
			"kg_deployments_running_stack",
			"kg_prior_root_causes",
			"kg_stack_instance_history",
			"kg_stacks_using_module",
		]);
	});

	test("loud-fail when disabled: tells the model not to answer from prose", async () => {
		const out = await call(await connectedClient(false), "kg_stacks_using_module", { module: "lifecycle" });
		expect(out).toContain("KNOWLEDGE GRAPH UNAVAILABLE");
		expect(out).toContain("Do NOT answer from memory");
	});

	test("SIO-968 regression: enabled via the arg even when process.env is unset", async () => {
		// The bug: tools re-read process.env per call and reported "disabled" despite the
		// server booting enabled. Now the arg decides -- so an unset env must NOT disable it.
		const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		try {
			const store = new InMemoryGraphStore();
			store.stub("OF_STACK", [{ deployment: "eu-b2b" }]);
			_setGraphStoreForTesting(store);
			const out = await call(await connectedClient(true), "kg_deployments_running_stack", { stack: "slos" });
			expect(out).toContain("eu-b2b");
			expect(out).not.toContain("UNAVAILABLE");
		} finally {
			if (prev === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
			else process.env.KNOWLEDGE_GRAPH_ENABLED = prev;
		}
	});

	test("kg_deployments_running_stack renders the reader rows", async () => {
		const store = new InMemoryGraphStore();
		store.stub("OF_STACK", [{ deployment: "eu-cld" }, { deployment: "us-cld" }]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_deployments_running_stack", { stack: "slos" });
		expect(out).toContain("Deployments running the slos stack: eu-cld, us-cld.");
	});

	test("empty result is reported as an authoritative graph result, not a guess invite", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_stacks_using_module", { module: "nope" });
		expect(out).toContain("Graph queried");
		expect(out).toContain("do not substitute a guess from specs");
	});

	test("kg_stacks_using_module renders rows", async () => {
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		_setGraphStoreForTesting(store);
		expect(await call(await connectedClient(), "kg_stacks_using_module", { module: "lifecycle" })).toContain(
			"Stacks using the lifecycle module: lifecycle-policies.",
		);
	});

	test("kg_stack_instance_history renders outcome-tagged lines", async () => {
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

	// SIO-1026: prior root causes.
	test("kg_prior_root_causes renders prior incidents + resolving runbooks", async () => {
		const store = new InMemoryGraphStore();
		store.stub("RootCause {class:", [
			{
				incidentId: "inc1",
				summary: "kafka outage",
				severity: "high",
				description: "lag",
				runbook: "a.md",
				createdAt: "2026-06-30",
			},
		]);
		_setGraphStoreForTesting(store);
		const out = await call(await connectedClient(), "kg_prior_root_causes", { causeClass: "kafka-significant-lag" });
		expect(out).toContain("Prior incidents with the kafka-significant-lag root cause");
		expect(out).toContain("[high] kafka outage (incident inc1) resolved by a.md");
	});

	test("kg_prior_root_causes empty result is an authoritative graph result", async () => {
		_setGraphStoreForTesting(new InMemoryGraphStore());
		const out = await call(await connectedClient(), "kg_prior_root_causes", { causeClass: "nope" });
		expect(out).toContain("no prior incident recorded the nope root cause");
	});
});
