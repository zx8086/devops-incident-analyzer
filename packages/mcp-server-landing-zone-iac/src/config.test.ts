import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

describe("Landing Zone MCP config", () => {
	test("uses a dedicated local port and the shared GitLab endpoint", () => {
		const config = loadConfig();
		expect(config.transport.port).toBe(9088);
		expect(config.transport.path).toBe("/mcp");
		expect(config.gitlab.baseUrl).toBe("https://gitlab.com");
		expect(config.gitlab.maxResponseBytes).toBe(200_000);
	});
});
