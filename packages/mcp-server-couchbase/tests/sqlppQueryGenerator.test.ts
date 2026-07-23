// tests/sqlppQueryGenerator.test.ts
//
// SIO-1078: the generate_sqlpp_query prompt previously told the LLM to build a
// fully-qualified `bucket`.`scope`.`collection` path, which capella_run_sql_plus_plus_query
// then rejects (it runs under SDK scope context, where the FROM clause must be the
// collection name only). These tests lock the prompt to collection-only guidance.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSqlppQueryGenerator } from "../src/prompts/sqlppQueryGenerator";

type PromptHandler = (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> };

// Minimal stub that captures the (name, schema, handler) registration so the test
// can invoke the handler directly without a live MCP server.
function capturePrompt(): { getText: (args: Record<string, string>) => string } {
	let handler: PromptHandler | undefined;
	const server = {
		prompt: (_name: string, _schema: unknown, cb: PromptHandler) => {
			handler = cb;
		},
	} as unknown as McpServer;

	registerSqlppQueryGenerator(server);
	if (!handler) throw new Error("prompt handler was not registered");
	const bound = handler;

	return {
		getText: (args) => bound(args).messages[0]?.content.text ?? "",
	};
}

describe("generate_sqlpp_query prompt (SIO-1078 scope-context)", () => {
	test("does NOT emit a fully-qualified path built from the actual identifiers", () => {
		const { getText } = capturePrompt();
		const text = getText({
			description: "count hotels",
			bucket: "travel-sample",
			scope: "inventory",
			collection: "hotel",
		});

		// The prompt must not construct a runnable `bucket`.`scope`.`collection` path from
		// the caller's identifiers (the shape the runtime guard rejects). The literal
		// "`bucket`.`scope`.`collection`" warning example is allowed -- it teaches the LLM
		// what NOT to do -- so we assert on the concrete values, not the generic template.
		expect(text).not.toContain("`travel-sample`.`inventory`.`hotel`");
		expect(text).not.toMatch(/travel-sample\.inventory\.hotel/);
	});

	test("instructs collection-only FROM and passes the scope separately", () => {
		const { getText } = capturePrompt();
		const text = getText({
			description: "count hotels",
			bucket: "travel-sample",
			scope: "inventory",
			collection: "hotel",
		});

		expect(text.toLowerCase()).toContain("collection name");
		// The scope must be steered to the scope_name argument, not the FROM clause.
		expect(text).toContain("scope_name");
		// The collection is still surfaced so the LLM knows what to query.
		expect(text).toContain("hotel");
	});

	test("works when scope is omitted (defaults handled by the tool)", () => {
		const { getText } = capturePrompt();
		const text = getText({
			description: "count hotels",
			bucket: "travel-sample",
			collection: "hotel",
		});

		// No runnable path from the actual identifiers (scope defaults to _default).
		expect(text).not.toContain("`travel-sample`.`_default`.`hotel`");
		expect(text).toContain("hotel");
	});

	// SIO-1176: steer away from non-sargable leading-wildcard LIKE with a
	// copy-paste good/bad pair (Haiku sub-agents need concrete examples).
	test("includes leading-wildcard LIKE guidance with good/bad examples", () => {
		const { getText } = capturePrompt();
		const text = getText({
			description: "count hotels",
			bucket: "travel-sample",
			scope: "inventory",
			collection: "hotel",
		});

		expect(text).toContain("leading-wildcard LIKE");
		expect(text).toContain('LIKE "%0003307479%"');
		expect(text).toContain('LIKE "ORDER::0003307479%"');
		expect(text).toContain("USE KEYS");
		expect(text).toContain("capella_get_document_by_id");
	});
});
