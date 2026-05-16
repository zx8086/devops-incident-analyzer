// packages/agent/src/wiring-atlassian.test.ts
// SIO-766: assert the atlassian datasource is plumbed through every wiring table.
import { describe, expect, test } from "bun:test";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { DATASOURCE_TO_MCP_SERVER } from "./mcp-bridge.ts";
import type { AgentName } from "./state.ts";
import { AGENT_NAMES as SUB_AGENT_AGENT_NAMES } from "./sub-agent.ts";
import { AGENT_NAMES as SUPERVISOR_AGENT_NAMES } from "./supervisor.ts";

describe("Atlassian datasource wiring", () => {
	test("DATA_SOURCE_IDS includes 'atlassian'", () => {
		expect(DATA_SOURCE_IDS).toContain("atlassian");
	});

	test("AgentName union accepts 'atlassian-agent'", () => {
		const name: AgentName = "atlassian-agent";
		expect(name).toBe("atlassian-agent");
	});

	test("supervisor's AGENT_NAMES maps atlassian -> atlassian-agent", () => {
		expect(SUPERVISOR_AGENT_NAMES.atlassian).toBe("atlassian-agent");
	});

	test("sub-agent's AGENT_NAMES maps atlassian -> atlassian-agent", () => {
		expect(SUB_AGENT_AGENT_NAMES.atlassian).toBe("atlassian-agent");
	});

	test("mcp-bridge DATASOURCE_TO_MCP_SERVER routes atlassian -> atlassian-mcp", () => {
		expect(DATASOURCE_TO_MCP_SERVER.atlassian).toBe("atlassian-mcp");
	});
});
