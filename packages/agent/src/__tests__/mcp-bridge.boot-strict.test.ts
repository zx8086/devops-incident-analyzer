import { describe, expect, test } from "bun:test";
import { MCP_SERVER_TO_ROLE, McpRoleMismatchError } from "../mcp-bridge.ts";

describe("McpRoleMismatchError", () => {
	test("is an Error subclass with the expected name", () => {
		const err = new McpRoleMismatchError("test message");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("McpRoleMismatchError");
		expect(err.message).toBe("test message");
	});
});

describe("MCP_SERVER_TO_ROLE", () => {
	test("maps all 9 server names to expected roles", () => {
		expect(MCP_SERVER_TO_ROLE).toEqual({
			"elastic-mcp": "elastic-mcp",
			"kafka-mcp": "kafka-proxy",
			"couchbase-mcp": "couchbase-mcp",
			"konnect-mcp": "konnect-mcp",
			"gitlab-mcp": "gitlab-mcp",
			"atlassian-mcp": "atlassian-mcp",
			"aws-mcp": "aws-proxy",
			"elastic-iac-mcp": "elastic-iac-mcp",
			"knowledge-graph-mcp": "knowledge-graph-mcp",
		});
	});
});
