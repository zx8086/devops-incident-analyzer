// src/config.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const prevCypher = process.env.KG_MCP_ALLOW_CYPHER;
const prevEnabled = process.env.KNOWLEDGE_GRAPH_ENABLED;

afterEach(() => {
	if (prevCypher === undefined) delete process.env.KG_MCP_ALLOW_CYPHER;
	else process.env.KG_MCP_ALLOW_CYPHER = prevCypher;
	if (prevEnabled === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prevEnabled;
});

describe("knowledgeGraphEnabled default (SIO-968)", () => {
	test("is ON when KNOWLEDGE_GRAPH_ENABLED is unset", () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		expect(loadConfig().knowledgeGraphEnabled).toBe(true);
	});

	test("is OFF only when explicitly disabled (false/0)", () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "false";
		expect(loadConfig().knowledgeGraphEnabled).toBe(false);
		process.env.KNOWLEDGE_GRAPH_ENABLED = "0";
		expect(loadConfig().knowledgeGraphEnabled).toBe(false);
	});
});

describe("allowCypher default", () => {
	test("is ON when KG_MCP_ALLOW_CYPHER is unset", () => {
		delete process.env.KG_MCP_ALLOW_CYPHER;
		expect(loadConfig().allowCypher).toBe(true);
	});

	test("is ON for explicit true/1", () => {
		process.env.KG_MCP_ALLOW_CYPHER = "true";
		expect(loadConfig().allowCypher).toBe(true);
		process.env.KG_MCP_ALLOW_CYPHER = "1";
		expect(loadConfig().allowCypher).toBe(true);
	});

	test("is OFF only when explicitly disabled", () => {
		process.env.KG_MCP_ALLOW_CYPHER = "false";
		expect(loadConfig().allowCypher).toBe(false);
		process.env.KG_MCP_ALLOW_CYPHER = "0";
		expect(loadConfig().allowCypher).toBe(false);
	});
});
