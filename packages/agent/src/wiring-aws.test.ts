// packages/agent/src/wiring-aws.test.ts
// SIO-760: assert the aws datasource is plumbed through every wiring table.
import { describe, expect, test } from "bun:test";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { DATASOURCE_TO_MCP_SERVER } from "./mcp-bridge.ts";
import type { AgentName } from "./state.ts";
import { AGENT_NAMES as SUB_AGENT_AGENT_NAMES } from "./sub-agent.ts";
import { AGENT_NAMES as SUPERVISOR_AGENT_NAMES } from "./supervisor.ts";

describe("AWS datasource wiring", () => {
	test("DATA_SOURCE_IDS includes 'aws'", () => {
		expect(DATA_SOURCE_IDS).toContain("aws");
	});

	test("AgentName union accepts 'aws-agent'", () => {
		// Type-level assertion: this assignment compiles only if 'aws-agent' is in the union.
		const name: AgentName = "aws-agent";
		expect(name).toBe("aws-agent");
	});

	test("supervisor's AGENT_NAMES maps aws -> aws-agent", () => {
		expect(SUPERVISOR_AGENT_NAMES.aws).toBe("aws-agent");
	});

	test("sub-agent's AGENT_NAMES maps aws -> aws-agent", () => {
		expect(SUB_AGENT_AGENT_NAMES.aws).toBe("aws-agent");
	});

	test("mcp-bridge DATASOURCE_TO_MCP_SERVER routes aws -> aws-mcp", () => {
		expect(DATASOURCE_TO_MCP_SERVER.aws).toBe("aws-mcp");
	});
});
