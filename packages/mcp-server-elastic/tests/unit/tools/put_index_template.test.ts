// tests/unit/tools/put_index_template.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerPutIndexTemplateTool } from "../../../src/tools/template/put_index_template.js";
import { initializeReadOnlyManager } from "../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type PutCall = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function makeHandler(): { handler: Handler; calls: { last?: PutCall } } {
	const calls: { last?: PutCall } = {};
	const stub = {
		indices: {
			putIndexTemplate: async (body: PutCall) => {
				calls.last = body;
				return { acknowledged: true };
			},
		},
	} as unknown as Client;

	initializeReadOnlyManager(false, false);
	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerPutIndexTemplateTool(server, stub);
	const tool = getToolFromServer(server, "elasticsearch_put_index_template");
	if (!tool) throw new Error("tool not registered");
	return { handler: tool.handler as Handler, calls };
}

describe("put_index_template ignore_missing_component_templates (SIO-662)", () => {
	let handler: Handler;
	let calls: { last?: PutCall };

	beforeEach(() => {
		const ctx = makeHandler();
		handler = ctx.handler;
		calls = ctx.calls;
	});

	test("forwards ignoreMissingComponentTemplates as ignore_missing_component_templates", async () => {
		await handler({
			name: "logs-edi.generic-na_edi_nonprod-override",
			indexPatterns: ["logs-edi.generic-*"],
			composedOf: ["metrics@tsdb-settings", "system@custom"],
			ignoreMissingComponentTemplates: ["system@custom"],
		});

		expect(calls.last?.ignore_missing_component_templates).toEqual(["system@custom"]);
		expect(calls.last?.composed_of).toEqual(["metrics@tsdb-settings", "system@custom"]);
	});

	test("omits ignore_missing_component_templates when not provided (back-compat)", async () => {
		await handler({
			name: "back-compat-template",
			indexPatterns: ["logs-*"],
			composedOf: ["metrics@tsdb-settings"],
		});

		expect(calls.last).toBeDefined();
		expect(calls.last?.ignore_missing_component_templates).toBeUndefined();
	});

	test("rejects non-array ignoreMissingComponentTemplates with validation error", async () => {
		let threw: unknown;
		try {
			await handler({
				name: "invalid-shape",
				indexPatterns: ["logs-*"],
				ignoreMissingComponentTemplates: "system@custom" as unknown as string[],
			});
		} catch (error) {
			threw = error;
		}

		expect(threw).toBeInstanceOf(McpError);
		expect((threw as McpError).message).toContain("Validation failed");
		expect(calls.last).toBeUndefined();
	});
});
