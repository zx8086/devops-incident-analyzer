// test/error-envelope.test.ts

import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../src/atlassian-client/index.js";
import { AtlassianAuthRequiredError, AtlassianUpstreamError } from "../src/tools/custom/parse-atlassian-content.js";
import { classifyErrorMessage, envelopeText, toolErrorResult } from "../src/tools/error-envelope.js";
import { confluencePageIdRejection, registerProxyTools } from "../src/tools/proxy/index.js";

function extractEnvelope(text: string): { kind?: string; category?: string; advice?: string } | undefined {
	const start = text.indexOf('{"_error"');
	if (start === -1) return undefined;
	return (JSON.parse(text.slice(start)) as { _error?: { kind?: string; category?: string; advice?: string } })._error;
}

describe("SIO-1183: classifyErrorMessage", () => {
	test.each([
		["McpError: MCP error -32001: Request timed out", "timeout"],
		["Error calling tool: ETIMEDOUT", "timeout"],
		["TypeError: fetch failed", "network"],
		["connect ECONNREFUSED 127.0.0.1:443", "network"],
		["MCP error -32602: Input validation error", "bad-input"],
		["something entirely novel", "unknown"],
	])("%s -> %s", (message, kind) => {
		expect(classifyErrorMessage(message)).toBe(kind);
	});
});

describe("SIO-1183: envelopeText", () => {
	test("prose first, parseable {_error} appended, prose duplicated into advice", () => {
		const text = envelopeText("Error: boom", { kind: "timeout", message: "boom" });
		expect(text.startsWith("Error: boom")).toBe(true);
		const env = extractEnvelope(text);
		expect(env?.kind).toBe("timeout");
		expect(env?.category).toBe("transient");
		expect(env?.advice).toBe("Error: boom");
	});
});

describe("SIO-1183: toolErrorResult classification", () => {
	test("AtlassianAuthRequiredError -> auth-expired (session category)", () => {
		const result = toolErrorResult(new AtlassianAuthRequiredError("ATLASSIAN_AUTH_REQUIRED: run oauth:seed"));
		expect(result.isError).toBe(true);
		const env = extractEnvelope(result.content[0]?.text ?? "");
		expect(env?.kind).toBe("auth-expired");
		expect(env?.category).toBe("session");
	});

	test.each([
		["Upstream searchConfluenceUsingCql error: Search failed: 403 Forbidden", "auth-denied"],
		["Upstream searchConfluenceUsingCql error: Search failed: 400 Bad Request", "bad-input"],
		["Upstream getJiraIssue error: 404 not found", "not-found"],
		["Upstream searchJiraIssuesUsingJql error: 500 Internal Server Error", "server-error"],
		// no status, no recognizable shape: a rejected upstream call defaults to bad-input
		["Upstream searchJiraIssuesUsingJql error: no content blocks", "bad-input"],
	])("AtlassianUpstreamError %s -> %s", (message, kind) => {
		const result = toolErrorResult(new AtlassianUpstreamError("someTool", message));
		expect(extractEnvelope(result.content[0]?.text ?? "")?.kind).toBe(kind);
	});

	test("plain -32001 timeout -> timeout kind (transient, retryable agent-side)", () => {
		const result = toolErrorResult(new Error("McpError: MCP error -32001: Request timed out"));
		const env = extractEnvelope(result.content[0]?.text ?? "");
		expect(env?.kind).toBe("timeout");
		expect(env?.category).toBe("transient");
	});
});

describe("SIO-1183: confluencePageIdRejection", () => {
	test("Jira issue key as pageId is rejected with steering to the Jira reader", () => {
		const rejection = confluencePageIdRejection("getConfluencePage", { pageId: "DEVOPS-1396" });
		expect(rejection?._error.kind).toBe("bad-input");
		expect(rejection?._error.advice).toContain("atlassian_getJiraIssue");
		expect(rejection?._error.advice).toContain("atlassian_fetch");
	});

	test("numeric ids, tiny-link ids, and other tools pass through", () => {
		expect(confluencePageIdRejection("getConfluencePage", { pageId: "2741665794" })).toBeNull();
		expect(confluencePageIdRejection("getConfluencePage", { pageId: "Fc1bBw" })).toBeNull();
		expect(confluencePageIdRejection("getConfluencePage", { pageId: 2741665794 })).toBeNull();
		expect(confluencePageIdRejection("getJiraIssue", { pageId: "DEVOPS-1396" })).toBeNull();
		expect(confluencePageIdRejection("getConfluencePage", {})).toBeNull();
	});
});

// Exercise the registered proxy handler end-to-end: the pageId guard sits in front of the
// upstream round trip, the catch path emits the envelope, and upstream isError prose
// passes through UNWRAPPED (SIO-1181 runbook rule).
describe("SIO-1183: registered proxy handler error paths (e2e)", () => {
	type ToolHandler = (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;

	function registerAndGetHandler(callTool: ReturnType<typeof mock>) {
		const handlers = new Map<string, ToolHandler>();
		const server = {
			tool: (name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
				handlers.set(name, handler);
			},
		} as unknown as McpServer;
		const proxy = { callTool } as unknown as AtlassianMcpProxy;
		const remoteTools: ProxyToolInfo[] = [
			{
				name: "getConfluencePage",
				description: "Get a Confluence page",
				inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
			},
		];
		registerProxyTools(server, proxy, remoteTools, { readOnly: true });
		const handler = handlers.get("atlassian_getConfluencePage");
		if (!handler) throw new Error("tool was not registered");
		return handler;
	}

	test("Jira-key pageId returns the steering envelope WITHOUT calling upstream", async () => {
		const callTool = mock(async () => ({ content: [{ type: "text", text: "should not be reached" }] }));
		const handler = registerAndGetHandler(callTool);

		const result = await handler({ pageId: "DEVOPS-1396" });

		expect(callTool).not.toHaveBeenCalled();
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { _error?: { kind?: string; advice?: string } };
		expect(parsed._error?.kind).toBe("bad-input");
		expect(parsed._error?.advice).toContain("atlassian_getJiraIssue");
	});

	test("a thrown -32001 timeout surfaces as an isError result carrying the timeout envelope", async () => {
		const callTool = mock(async () => {
			throw new Error("McpError: MCP error -32001: Request timed out");
		});
		const handler = registerAndGetHandler(callTool);

		const result = await handler({ pageId: "2741665794" });

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text.startsWith("Error: ")).toBe(true);
		expect(extractEnvelope(text)?.kind).toBe("timeout");
	});

	test("upstream isError prose passes through UNWRAPPED", async () => {
		const upstreamText = '{"error":true,"message":"Failed to get page: 400 Bad Request"}';
		const callTool = mock(async () => ({ content: [{ type: "text", text: upstreamText }], isError: true }));
		const handler = registerAndGetHandler(callTool);

		const result = await handler({ pageId: "2741665794" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(upstreamText);
		expect(result.content[0]?.text).not.toContain("_error");
	});
});

// One representative custom tool: the registration catch now envelopes typed parse errors.
describe("SIO-1183: findLinkedIncidents catch envelopes upstream failures (e2e)", () => {
	test("upstream isError result -> AtlassianUpstreamError -> bad-input envelope", async () => {
		const { registerFindLinkedIncidents } = await import("../src/tools/custom/find-linked-incidents.js");
		type ToolHandler = (args: Record<string, unknown>) => Promise<{
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		}>;
		const handlers = new Map<string, ToolHandler>();
		const server = {
			tool: (name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
				handlers.set(name, handler);
			},
		} as unknown as McpServer;
		const proxy = {
			callTool: async () => ({
				content: [{ type: "text", text: "Input validation error: -32602" }],
				isError: true,
			}),
		} as unknown as AtlassianMcpProxy;
		registerFindLinkedIncidents(server, proxy, [], undefined);
		const handler = handlers.get("findLinkedIncidents");
		if (!handler) throw new Error("tool was not registered");

		const result = await handler({ service: "stock-service" });

		expect(result.isError).toBe(true);
		const env = extractEnvelope(result.content[0]?.text ?? "");
		expect(env?.kind).toBe("bad-input");
	});
});
