// agent/src/iac/local-tools.test.ts
//
// SIO-966: the LLM-callable knowledge-graph + memory query tools.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import {
	createQueryKnowledgeGraphTool,
	createSearchMemoryTool,
	runKnowledgeGraphQuery,
	runMemorySearch,
} from "./local-tools.ts";

const prevKg = process.env.KNOWLEDGE_GRAPH_ENABLED;
const prevBackend = process.env.LIVE_MEMORY_BACKEND;

beforeEach(() => {
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	if (prevKg === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prevKg;
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	_setGraphStoreForTesting(null);
});

describe("runKnowledgeGraphQuery", () => {
	test("soft-fails when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const out = await runKnowledgeGraphQuery({ query_type: "stacks_using_module", module: "lifecycle" });
		expect(out).toContain("disabled");
	});

	test("deployments_running_stack renders the reader rows", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("OF_STACK", [{ deployment: "eu-cld" }, { deployment: "us-cld" }]);
		_setGraphStoreForTesting(store);
		const out = await runKnowledgeGraphQuery({ query_type: "deployments_running_stack", stack: "slos" });
		expect(out).toBe("Deployments running the slos stack: eu-cld, us-cld.");
	});

	test("stacks_using_module renders rows; empty -> friendly message", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "lifecycle-policies" }]);
		_setGraphStoreForTesting(store);
		expect(await runKnowledgeGraphQuery({ query_type: "stacks_using_module", module: "lifecycle" })).toBe(
			"Stacks using the lifecycle module: lifecycle-policies.",
		);
		const empty = new InMemoryGraphStore();
		_setGraphStoreForTesting(empty);
		expect(await runKnowledgeGraphQuery({ query_type: "stacks_using_module", module: "nope" })).toContain(
			"No stacks use",
		);
	});

	test("stack_instance_history renders outcome-tagged lines", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("TARGETS", [
			{ id: "c1", workflow: "slo-edit", summary: "tighten", outcome: "applied", mrUrl: "u9", createdAt: "x" },
		]);
		_setGraphStoreForTesting(store);
		const out = await runKnowledgeGraphQuery({
			query_type: "stack_instance_history",
			deployment: "eu-cld",
			stack: "slos",
		});
		expect(out).toContain("Recent changes to eu-cld/slos");
		expect(out).toContain("[applied] slo-edit: tighten (u9)");
	});

	test("validates required params per query type", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		_setGraphStoreForTesting(new InMemoryGraphStore());
		expect(await runKnowledgeGraphQuery({ query_type: "deployments_running_stack" })).toContain("needs a stack");
		expect(await runKnowledgeGraphQuery({ query_type: "stack_instance_history", deployment: "eu-cld" })).toContain(
			"needs both",
		);
	});
});

describe("runMemorySearch", () => {
	test("soft-fails when the backend is not agent-memory", async () => {
		delete process.env.LIVE_MEMORY_BACKEND; // file backend
		const out = await runMemorySearch("elastic-iac", { query: "eu-b2b upgrade" });
		expect(out).toContain("No matching memory");
	});

	test("renders hits with KG-key tags when the agent-memory backend returns rows", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				// echo the filter back so the test proves it is forwarded
				expect(opts?.annotations).toEqual({ deployment: "eu-b2b", stack: "lifecycle-policies" });
				return [
					{
						text: "Elastic IaC change proposed on eu-b2b/lifecycle-policies: metrics warm.",
						score: 0.9,
						annotations: { deployment: "eu-b2b", stack: "lifecycle-policies", outcome: "completed" },
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-966 - test stub for the AgentMemoryClient surface
		} as any);
		const out = await runMemorySearch("elastic-iac", {
			query: "metrics policy",
			deployment: "eu-b2b",
			stack: "lifecycle-policies",
		});
		expect(out).toContain("metrics warm");
		expect(out).toContain("[eu-b2b lifecycle-policies completed]");
		__setAgentMemoryClient(null);
		delete process.env.LIVE_MEMORY_BACKEND;
	});
});

describe("tool factories", () => {
	test("expose the documented names + zod schemas", () => {
		const kg = createQueryKnowledgeGraphTool();
		const mem = createSearchMemoryTool("elastic-iac");
		expect(kg.name).toBe("query_knowledge_graph");
		expect(mem.name).toBe("search_memory");
		expect(kg.description).toContain("knowledge graph");
		expect(mem.description.toLowerCase()).toContain("memory");
	});

	test("the KG tool invokes end-to-end through the LangChain tool surface", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("USES_MODULE", [{ stack: "slos" }]);
		_setGraphStoreForTesting(store);
		const kg = createQueryKnowledgeGraphTool();
		const out = (await kg.invoke({ query_type: "stacks_using_module", module: "slo" })) as string;
		expect(out).toContain("slos");
	});
});
