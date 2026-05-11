// shared/src/__tests__/agentcore-proxy-tool-status.test.ts
//
// SIO-718: classifyToolStatus classifies the JSON-RPC tool result body so the
// proxy's dev log can show the actual tool outcome on each line, without
// needing to interpret the AgentCore HTTP envelope separately.

import { describe, expect, test } from "bun:test";
import { classifyToolStatus, severityForToolStatus } from "../agentcore-proxy.ts";

const sse = (json: string) => `event: message\ndata: ${json}\n\n`;

describe("classifyToolStatus", () => {
	test("returns ok for a successful tool result", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: '{"version":"7.2.1"}' }],
				},
			}),
		);
		expect(classifyToolStatus(body)).toBe("ok");
	});

	test("classifies ksqlDB 503 from a typical isError body", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: "MCP error -32603: ksqlDB error 503: <html><body>503 Service Temporarily Unavailable</body></html>",
						},
					],
				},
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (ksqlDB 503)");
	});

	test("classifies Kafka Connect 503", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: "MCP error -32603: Kafka Connect error 503: <html>503</html>",
						},
					],
				},
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (Kafka Connect 503)");
	});

	test("classifies Schema Registry 503", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: "MCP error -32603: Schema Registry error 503: nginx",
						},
					],
				},
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (Schema Registry 503)");
	});

	test("falls back to generic message for non-matching isError", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: "MCP error -32602: Invalid params: missing required field 'topic'",
						},
					],
				},
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (Invalid params: missing required field 'topic')");
	});

	test("truncates long generic error messages to 60 chars", () => {
		const longMessage = "A".repeat(120);
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 5,
				result: {
					isError: true,
					content: [{ type: "text", text: `MCP error -32603: ${longMessage}` }],
				},
			}),
		);
		const result = classifyToolStatus(body);
		// "error (" + 60 chars + ")"
		expect(result).toBe(`error (${"A".repeat(60)})`);
	});

	test("returns jsonrpc-error for top-level transport errors", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 6,
				error: { code: -32600, message: "Invalid Request" },
			}),
		);
		expect(classifyToolStatus(body)).toBe("jsonrpc-error");
	});

	test("returns unparseable for malformed JSON", () => {
		const body = sse("not-valid-json");
		expect(classifyToolStatus(body)).toBe("unparseable");
	});

	test("returns unparseable when there is no data: frame and no JSON either", () => {
		expect(classifyToolStatus("garbage with no data prefix")).toBe("unparseable");
	});

	test("returns unparseable for an empty body", () => {
		expect(classifyToolStatus("")).toBe("unparseable");
	});

	test("handles raw JSON (no SSE framing) for application/json responses", () => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(classifyToolStatus(body)).toBe("ok");
	});

	test("uses the LAST data: frame in a multi-frame SSE stream", () => {
		const okFrame = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 8,
				result: { content: [{ type: "text", text: "partial" }] },
			}),
		);
		const errFrame = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 8,
				result: {
					isError: true,
					content: [{ type: "text", text: "MCP error -32603: ksqlDB error 503: nginx" }],
				},
			}),
		);
		expect(classifyToolStatus(okFrame + errFrame)).toBe("error (ksqlDB 503)");
	});

	test("returns error (unclassified) when isError is true but content is missing", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				result: { isError: true, content: [] },
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (unclassified)");
	});

	test("returns error (no-text) when isError is true but first content has no text", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 10,
				result: { isError: true, content: [{ type: "image", data: "..." }] },
			}),
		);
		expect(classifyToolStatus(body)).toBe("error (no-text)");
	});
});

describe("severityForToolStatus", () => {
	test("ok maps to info", () => {
		expect(severityForToolStatus("ok")).toBe("info");
	});

	test("any specific service error maps to warn", () => {
		expect(severityForToolStatus("error (ksqlDB 503)")).toBe("warn");
		expect(severityForToolStatus("error (Kafka Connect 503)")).toBe("warn");
		expect(severityForToolStatus("error (Schema Registry 503)")).toBe("warn");
		expect(severityForToolStatus("error (REST Proxy 502)")).toBe("warn");
	});

	test("generic and unparsed error variants map to warn", () => {
		expect(severityForToolStatus("error (Invalid params: missing field)")).toBe("warn");
		expect(severityForToolStatus("error (unclassified)")).toBe("warn");
		expect(severityForToolStatus("error (no-text)")).toBe("warn");
		expect(severityForToolStatus("error (unparsed)")).toBe("warn");
	});

	test("transport-level errors and unparseable map to warn", () => {
		expect(severityForToolStatus("jsonrpc-error")).toBe("warn");
		expect(severityForToolStatus("unparseable")).toBe("warn");
	});
});
