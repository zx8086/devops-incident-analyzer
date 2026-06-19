// src/config.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const prev = process.env.KG_MCP_ALLOW_CYPHER;

afterEach(() => {
	if (prev === undefined) delete process.env.KG_MCP_ALLOW_CYPHER;
	else process.env.KG_MCP_ALLOW_CYPHER = prev;
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
