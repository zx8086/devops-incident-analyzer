// shared/src/__tests__/agentcore-proxy-inner-status.test.ts
//
// SIO-718: classifyInnerStatus classifies the JSON-RPC tool result body so the
// proxy's dev log can show inner status alongside the outer HTTP envelope.

import { describe, expect, test } from "bun:test";
import { classifyInnerStatus } from "../agentcore-proxy.ts";

const sse = (json: string) => `event: message\ndata: ${json}\n\n`;

describe("classifyInnerStatus", () => {
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
		expect(classifyInnerStatus(body)).toBe("ok");
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
		expect(classifyInnerStatus(body)).toBe("error (ksqlDB 503)");
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
		expect(classifyInnerStatus(body)).toBe("error (Kafka Connect 503)");
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
		expect(classifyInnerStatus(body)).toBe("error (Schema Registry 503)");
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
		expect(classifyInnerStatus(body)).toBe("error (Invalid params: missing required field 'topic')");
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
		const result = classifyInnerStatus(body);
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
		expect(classifyInnerStatus(body)).toBe("jsonrpc-error");
	});

	test("returns unparseable for malformed JSON", () => {
		const body = sse("not-valid-json");
		expect(classifyInnerStatus(body)).toBe("unparseable");
	});

	test("returns unparseable when there is no data: frame and no JSON either", () => {
		expect(classifyInnerStatus("garbage with no data prefix")).toBe("unparseable");
	});

	test("returns unparseable for an empty body", () => {
		expect(classifyInnerStatus("")).toBe("unparseable");
	});

	test("handles raw JSON (no SSE framing) for application/json responses", () => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(classifyInnerStatus(body)).toBe("ok");
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
		expect(classifyInnerStatus(okFrame + errFrame)).toBe("error (ksqlDB 503)");
	});

	test("returns error (unclassified) when isError is true but content is missing", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				result: { isError: true, content: [] },
			}),
		);
		expect(classifyInnerStatus(body)).toBe("error (unclassified)");
	});

	test("returns error (no-text) when isError is true but first content has no text", () => {
		const body = sse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 10,
				result: { isError: true, content: [{ type: "image", data: "..." }] },
			}),
		);
		expect(classifyInnerStatus(body)).toBe("error (no-text)");
	});
});
