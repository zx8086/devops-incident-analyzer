#!/usr/bin/env bun

/**
 * SIO-1265 regression: elasticsearch_multi_search had no schema for `searches`, so the model sent a
 * natural-but-wrong {header, body} shape, ES rejected it, and the failure was invisible in the tool
 * result the sub-agent reads -- the report published it as "0 hits", a fabricated negative.
 */

import { describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMultiSearchTool, toMsearchBody } from "../../src/tools/search/multi_search.js";
import {
	registerMultiSearchTemplateTool,
	toMsearchTemplateBody,
} from "../../src/tools/template/multi_search_template.js";
import { getToolFromServer } from "../utils/elasticsearch-client.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

// The exact per-response error ES returned on run 2445908e.
const ILLEGAL_ARG = {
	error: { type: "illegal_argument_exception", reason: "key [header] is not supported in the metadata section" },
	status: 400,
};
const OK_RESPONSE = { hits: { total: { value: 7 }, hits: [] }, status: 200 };

function harness(responses: unknown[] = [OK_RESPONSE]) {
	const calls: { msearch?: Record<string, unknown>; msearchTemplate?: Record<string, unknown> } = {};
	const client = {
		msearch: async (p: Record<string, unknown>) => {
			calls.msearch = p;
			return { took: 3, responses };
		},
		msearchTemplate: async (p: Record<string, unknown>) => {
			calls.msearchTemplate = p;
			return { took: 2, responses };
		},
	} as unknown as Client;
	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerMultiSearchTool(server, client);
	registerMultiSearchTemplateTool(server, client);
	const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
		const tool = getToolFromServer(server, name);
		if (!tool) throw new Error(`${name} not registered`);
		return (await tool.handler(args, {})) as ToolResult;
	};
	return { calls, call };
}

describe("SIO-1265 elasticsearch_multi_search searches schema", () => {
	test("rejects the {header, body} shape that run 2445908e sent, before it reaches Elasticsearch", async () => {
		const { call, calls } = harness();
		const promise = call("elasticsearch_multi_search", {
			searches: [{ header: { index: "logs-*" }, body: { query: { match_all: {} } } }],
		});
		await expect(promise).rejects.toThrow(/searches` must be \{index\?, query\}/);
		// The point of validating: nothing was sent, so there is no failed response to misread.
		expect(calls.msearch).toBeUndefined();
	});

	test("the rejection tells the model what the right shape is, not just that it was wrong", async () => {
		const { call } = harness();
		let message = "";
		try {
			await call("elasticsearch_multi_search", { searches: [{ body: {} }] });
		} catch (e) {
			message = (e as Error).message;
		}
		// A bare "expected record, received undefined" is not recoverable from.
		expect(message).toContain("Do NOT use {header, body}");
		expect(message).toContain('{"index":"logs-*","query":{"query":{"match_all":{}},"size":5}}');
	});

	test("builds msearch's alternating metadata/body array from one object per logical search", async () => {
		const { call, calls } = harness();
		await call("elasticsearch_multi_search", {
			searches: [
				{ index: "logs-*", query: { query: { match_all: {} }, size: 1 } },
				{ query: { query: { term: { level: "error" } } } },
			],
			index: "fallback-*",
		});
		// Alternating: metadata, body, metadata, body. The second search carries EMPTY metadata so
		// Elasticsearch resolves it against the request-level `index`.
		expect(calls.msearch?.searches).toEqual([
			{ index: "logs-*" },
			{ query: { match_all: {} }, size: 1 },
			{},
			{ query: { term: { level: "error" } } },
		]);
	});

	test("toMsearchBody is a pure pair-builder", () => {
		expect(toMsearchBody([{ index: "a", query: { size: 1 } }])).toEqual([{ index: "a" }, { size: 1 }]);
		expect(toMsearchBody([{ query: { size: 2 } }])).toEqual([{}, { size: 2 }]);
		expect(toMsearchBody([])).toEqual([]);
	});
});

describe("SIO-1265 multi_search failure is visible in the tool result", () => {
	// notificationManager never reaches the sub-agent -- only `content` does. A per-response error
	// buried in the raw msearch JSON was skimmed as an empty result and published as "0 hits".
	test("a failed search puts the failure count on the FIRST line of content", async () => {
		const { call } = harness([ILLEGAL_ARG, OK_RESPONSE]);
		const result = await call("elasticsearch_multi_search", {
			searches: [
				{ index: "a", query: { query: {} } },
				{ index: "b", query: { query: {} } },
			],
		});
		const firstLine = result.content[0].text.split("\n")[0];
		expect(firstLine).toBe("WARNING: 1 of 2 searches FAILED and returned NO results.");
		// The instruction the report needed and did not get.
		expect(result.content[0].text).toContain("A failed search is NOT a zero-hit search");
		// The raw payload is still there for the model to read the errors from.
		expect(result.content[0].text).toContain("illegal_argument_exception");
	});

	test("a clean result carries no warning header", async () => {
		const { call } = harness([OK_RESPONSE]);
		const result = await call("elasticsearch_multi_search", { searches: [{ index: "a", query: { query: {} } }] });
		expect(result.content[0].text.startsWith("{")).toBe(true);
		expect(result.content[0].text).not.toContain("WARNING");
	});

	test("total_searches counts LOGICAL searches, not the raw array length", async () => {
		// Pre-SIO-1265 the denominator was the alternating array's length, i.e. 2x the real count,
		// so every "N/M successful" string and failure_rate was silently halved.
		const { call } = harness([ILLEGAL_ARG, ILLEGAL_ARG]);
		const result = await call("elasticsearch_multi_search", {
			searches: [
				{ index: "a", query: { query: {} } },
				{ index: "b", query: { query: {} } },
			],
		});
		expect(result.content[0].text.split("\n")[0]).toContain("2 of 2 searches FAILED");
	});
});

describe("SIO-1265 elasticsearch_multi_search_template (same defect, sibling file)", () => {
	test("builds the alternating metadata/body array for templates", async () => {
		const { call, calls } = harness();
		await call("elasticsearch_multi_search_template", {
			searches: [{ index: "logs-*", id: "tpl", params: { n: 5 } }],
		});
		expect(calls.msearchTemplate?.search_templates).toEqual([{ index: "logs-*" }, { id: "tpl", params: { n: 5 } }]);
	});

	test("requires exactly one of id or source", async () => {
		const { call } = harness();
		await expect(
			call("elasticsearch_multi_search_template", { searches: [{ index: "a", id: "x", source: "y" }] }),
		).rejects.toThrow(/exactly one of `id`/);
		await expect(call("elasticsearch_multi_search_template", { searches: [{ index: "a" }] })).rejects.toThrow(
			/exactly one of `id`/,
		);
	});

	test("a failed template search states the failure count first", async () => {
		const { call } = harness([ILLEGAL_ARG]);
		const result = await call("elasticsearch_multi_search_template", { searches: [{ index: "a", id: "tpl" }] });
		expect(result.content[0].text.split("\n")[0]).toBe(
			"WARNING: 1 of 1 template searches FAILED and returned NO results.",
		);
	});

	test("toMsearchTemplateBody is a pure pair-builder", () => {
		expect(toMsearchTemplateBody([{ index: "a", id: "t" }])).toEqual([{ index: "a" }, { id: "t" }]);
		expect(toMsearchTemplateBody([{ source: "{{x}}", params: { x: 1 } }])).toEqual([
			{},
			{ source: "{{x}}", params: { x: 1 } },
		]);
	});
});
