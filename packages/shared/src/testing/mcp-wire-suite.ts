// shared/src/testing/mcp-wire-suite.ts
// SIO-1960: the dual-era wire suite every server ported to SDK v2 runs (recipe set by SIO-1958).
// It drives the server's real /mcp handler with raw JSON-RPC: one endpoint must serve the
// 2025-era protocol the agent speaks today and 2026-07-28, and the dispatch-level logging wrap
// that createMcpApplication installs must still stamp validation failures and count unknown
// tools on v2. Shared must not import the v2 SDK, so the caller builds the handler.
import { expect, test } from "bun:test";
import { installToolCallLogging, type ToolCallOutcome } from "../tool-call-logging.ts";

const MODERN = "2026-07-28";
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export interface WireHandler {
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
}

export interface DualEraWireSuiteOptions<S extends { readonly server: unknown }> {
	label: string;
	serverFactory: () => S;
	// createMcpHandler from @modelcontextprotocol/server, with { legacy: "stateless" }.
	createHandler: (factory: () => S) => WireHandler;
	// A tool that succeeds without any live backend.
	okTool: { name: string; args: Record<string, unknown> };
	// A call that fails the tool's input schema.
	invalidCall: { name: string; args: Record<string, unknown> };
}

const modernMeta = {
	"io.modelcontextprotocol/protocolVersion": MODERN,
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
};

type CallBody = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { code?: number } };

export function dualEraWireSuite<S extends { readonly server: unknown }>(opts: DualEraWireSuiteOptions<S>): void {
	const outcomes: ToolCallOutcome[] = [];
	// Same composition as production: createMcpApplication wraps each server with the logging wrap.
	const wrappedFactory = () => {
		const server = opts.serverFactory();
		installToolCallLogging(server, silent, undefined, (outcome) => outcomes.push(outcome));
		return server;
	};

	async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
		const handler = opts.createHandler(wrappedFactory);
		try {
			const res = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
					body: JSON.stringify({ jsonrpc: "2.0", ...body }),
				}),
			);
			// Bodies come back as plain JSON or SSE-framed ("data: <json>") depending on negotiation.
			const text = await res.text();
			const data = text
				.split("\n")
				.find((line) => line.startsWith("data:"))
				?.slice("data:".length)
				.trim();
			return { status: res.status, body: JSON.parse(data ?? text) as Record<string, unknown> };
		} finally {
			await handler.close();
		}
	}

	const legacyCall = (name: string, args: Record<string, unknown>) =>
		post({ id: 2, method: "tools/call", params: { name, arguments: args } });
	const modernCall = (name: string, args: Record<string, unknown>) =>
		post(
			{ id: 3, method: "tools/call", params: { name, arguments: args, _meta: modernMeta } },
			{ "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": name },
		);

	test(`${opts.label}: legacy initialize negotiates 2025-11-25`, async () => {
		const { status, body } = await post({
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
		});
		expect(status).toBe(200);
		expect((body.result as { protocolVersion?: string }).protocolVersion).toBe("2025-11-25");
	});

	test(`${opts.label}: server/discover advertises 2026-07-28 and tools`, async () => {
		const { status, body } = await post(
			{ id: 4, method: "server/discover", params: { _meta: modernMeta } },
			{ "MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover" },
		);
		expect(status).toBe(200);
		const result = body.result as { supportedVersions?: string[]; capabilities?: Record<string, unknown> };
		expect(result.supportedVersions).toEqual([MODERN]);
		expect(result.capabilities?.tools).toBeDefined();
	});

	for (const [era, call] of [
		["legacy", legacyCall],
		["modern", modernCall],
	] as const) {
		test(`${opts.label}: ${era} tools/call dispatches`, async () => {
			const { status, body } = await call(opts.okTool.name, opts.okTool.args);
			expect(status).toBe(200);
			expect((body as CallBody).error).toBeUndefined();
			expect((body as CallBody).result?.isError).not.toBe(true);
		});

		test(`${opts.label}: ${era} validation failure is stamped by the dispatch-level wrap`, async () => {
			const { body } = await call(opts.invalidCall.name, opts.invalidCall.args);
			const result = (body as CallBody).result;
			expect(result?.isError).toBe(true);
			const text = result?.content?.[0]?.text ?? "";
			expect(text).toContain('"_error"');
			expect(text).toContain('"kind":"bad-input"');
			expect(text).toContain('"category":"bad-query"');
		});

		test(`${opts.label}: ${era} unknown tool is a JSON-RPC -32602 error counted as unknown-tool`, async () => {
			outcomes.length = 0;
			const { body } = await call("zz_no_such_tool", {});
			expect((body as CallBody).result).toBeUndefined();
			expect((body as CallBody).error?.code).toBe(-32602);
			expect(outcomes).toEqual([
				{ tool: "zz_no_such_tool", ok: false, durationMs: expect.any(Number), failureClass: "unknown-tool" },
			]);
		});
	}
}
