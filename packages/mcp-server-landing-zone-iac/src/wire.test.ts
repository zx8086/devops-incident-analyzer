// src/wire.test.ts
// SIO-1958: raw wire tests for the v2 /mcp handler. One endpoint must serve the 2025-era protocol
// the agent speaks today (legacy: "stateless") and the 2026-07-28 protocol, and the dispatch-level
// logging wrap that createMcpApplication installs must still stamp validation failures on v2.
import { describe, expect, test } from "bun:test";
import { installToolCallLogging } from "@devops-agent/shared";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "./config.ts";
import { createMcpServerFactory } from "./server.ts";
import type { GitLabReadClient } from "./tools/repositories.ts";

const MODERN = "2026-07-28";
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function config(): Config {
	return {
		transport: { mode: "http", port: 1, host: "127.0.0.1", path: "/mcp" },
		gitlab: { baseUrl: "https://gitlab.example", token: undefined, timeoutMs: 30_000, maxResponseBytes: 200_000 },
		write: { enabled: false, allowedProjects: [], allowedPathPrefixes: {}, backendProjects: [] },
	};
}

// Same composition as production: createMcpApplication wraps each server with the logging wrap.
function handler() {
	const inner = createMcpServerFactory(config(), {} as GitLabReadClient);
	return createMcpHandler(
		() => {
			const server = inner();
			installToolCallLogging(server, silent);
			return server;
		},
		{ legacy: "stateless" },
	);
}

const modernMeta = {
	"io.modelcontextprotocol/protocolVersion": MODERN,
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
};

async function post(
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const h = handler();
	try {
		const res = await h.fetch(
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
		return { status: res.status, body: JSON.parse(data ?? text) };
	} finally {
		await h.close();
	}
}

function legacyCall(name: string, args: Record<string, unknown>, id = 2) {
	return post({ id, method: "tools/call", params: { name, arguments: args } });
}

function modernCall(name: string, args: Record<string, unknown>, id = 3) {
	return post(
		{ id, method: "tools/call", params: { name, arguments: args, _meta: modernMeta } },
		{ "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": name },
	);
}

type CallBody = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { code?: number } };

describe("SIO-1958: landing-zone-iac wire protocol on SDK v2", () => {
	test("legacy era: initialize negotiates 2025-11-25", async () => {
		const { status, body } = await post({
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
		});
		expect(status).toBe(200);
		expect((body.result as { protocolVersion?: string }).protocolVersion).toBe("2025-11-25");
	});

	test("legacy era: tools/call without a handshake dispatches (stateless)", async () => {
		const { status, body } = await legacyCall("lz_list_repositories", {});
		expect(status).toBe(200);
		const result = (body as CallBody).result;
		expect(result?.isError).not.toBe(true);
		expect(result?.content?.[0]?.text).toContain("repositories");
	});

	test("modern era: tools/call with the _meta envelope and headers dispatches", async () => {
		const { status, body } = await modernCall("lz_list_repositories", {});
		expect(status).toBe(200);
		const result = (body as CallBody).result;
		expect(result?.isError).not.toBe(true);
		expect(result?.content?.[0]?.text).toContain("repositories");
	});

	test("modern era: server/discover advertises 2026-07-28 and tools", async () => {
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
		test(`${era} era: a validation failure comes back stamped by the dispatch-level wrap`, async () => {
			const { body } = await call("lz_read_repository_files", { repository: "x", paths: [] });
			const result = (body as CallBody).result;
			expect(result?.isError).toBe(true);
			const text = result?.content?.[0]?.text ?? "";
			expect(text).toContain('"_error"');
			expect(text).toContain('"kind":"bad-input"');
			expect(text).toContain('"category":"bad-query"');
		});

		test(`${era} era: an unknown tool is a JSON-RPC -32602 error, not an isError result`, async () => {
			const { body } = await call("lz_no_such_tool", {});
			expect((body as CallBody).result).toBeUndefined();
			expect((body as CallBody).error?.code).toBe(-32602);
		});
	}
});
