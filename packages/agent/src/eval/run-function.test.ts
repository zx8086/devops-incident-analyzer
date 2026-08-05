// agent/src/eval/run-function.test.ts
import { describe, expect, mock, test } from "bun:test";

// SIO-1375 follow-up: run-function.ts's ensureMcpConnected() builds the McpClientConfig passed to
// createMcpClient. Every AWS eval run in the SIO-1374/SIO-1375 A/B legs (both before AND after the
// aggregator/validator/gitlab fixes) reported "No MCP tools available, skipping" for aws, 100% of
// runs -- confirmed via a live curl against the AWS MCP server (HTTP 200, 49 tools returned) that
// the server itself was healthy the whole time. The gap is in this file: createMcpClient's config
// object never included awsUrl, unlike every other datasource and unlike production's
// apps/web/src/lib/server/agent.ts:224 (`awsUrl: process.env.AWS_MCP_URL`). This test captures the
// exact config object the function builds and asserts awsUrl is present.
let capturedConfig: Record<string, unknown> | undefined;

mock.module("../mcp-bridge.ts", () => ({
	createMcpClient: (config: Record<string, unknown>) => {
		capturedConfig = config;
		return Promise.resolve();
	},
}));

mock.module("../graph.ts", () => ({
	buildGraph: () =>
		Promise.resolve({
			invoke: () => Promise.resolve({ messages: [], dataSourceResults: [] }),
		}),
}));

import { runAgent } from "./run-function.ts";

describe("ensureMcpConnected's createMcpClient config (SIO-1375 follow-up)", () => {
	test("includes awsUrl from AWS_MCP_URL, matching every other datasource", async () => {
		const prevAwsUrl = process.env.AWS_MCP_URL;
		process.env.AWS_MCP_URL = "http://localhost:3001";
		try {
			await runAgent({ query: "test query" });
		} finally {
			if (prevAwsUrl === undefined) delete process.env.AWS_MCP_URL;
			else process.env.AWS_MCP_URL = prevAwsUrl;
		}
		expect(capturedConfig?.awsUrl).toBe("http://localhost:3001");
	});
});
