import { describe, expect, test } from "bun:test";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { wrapElasticToolsWithDeployment } from "./elastic-tool-deployment-wrapper.ts";
import { withElasticDeployment } from "./mcp-bridge.ts";

function makeJsonSchemaTool(name: string): StructuredToolInterface {
	let lastArgs: Record<string, unknown> | undefined;
	const tool = createTool(
		async (args) => {
			lastArgs = args as Record<string, unknown>;
			return JSON.stringify(args);
		},
		{
			name,
			description: `${name} test tool`,
			// Real elastic tools declare `deployment` optional (withDeploymentField), so it is
			// in properties but never in `required`. Required-field stripping is covered by the
			// shared stripToolSchemaField via the AWS wrapper test.
			schema: {
				type: "object",
				properties: {
					deployment: { type: "string" },
					index: { type: "string" },
				},
				required: ["index"],
			},
		},
	) as unknown as StructuredToolInterface;
	(tool as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs = () => lastArgs;
	return tool;
}

function makeZodTool(name: string): StructuredToolInterface {
	let lastArgs: Record<string, unknown> | undefined;
	const tool = createTool(
		async (args) => {
			lastArgs = args as Record<string, unknown>;
			return JSON.stringify(args);
		},
		{
			name,
			description: `${name} test tool`,
			schema: z.object({ deployment: z.string().optional(), index: z.string() }),
		},
	) as unknown as StructuredToolInterface;
	(tool as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs = () => lastArgs;
	return tool;
}

describe("wrapElasticToolsWithDeployment (SIO-649)", () => {
	test("strips deployment from JSON Schema properties and required", () => {
		const original = makeJsonSchemaTool("elasticsearch_get_cluster_health");
		const wrapped = wrapElasticToolsWithDeployment([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		const schema = wrapped.schema as { properties: Record<string, unknown>; required?: string[] };
		expect(schema.properties).not.toHaveProperty("deployment");
		expect(schema.properties).toHaveProperty("index");
		expect(schema.required).toEqual(["index"]);
	});

	test("strips deployment from a Zod object schema", () => {
		const original = makeZodTool("elasticsearch_zod_tool");
		const wrapped = wrapElasticToolsWithDeployment([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		const shape = (wrapped.schema as z.ZodObject<z.ZodRawShape>).shape;
		expect("deployment" in shape).toBe(false);
		expect("index" in shape).toBe(true);
	});

	// Unlike AWS, elastic routes via the x-elastic-deployment header, so the wrapper
	// forwards args verbatim and injects nothing -- the header (set by the fan-out) routes.
	test("forwards args unchanged and does not inject a deployment", async () => {
		const original = makeJsonSchemaTool("elasticsearch_forward_tool");
		const wrapped = wrapElasticToolsWithDeployment([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		await withElasticDeployment("eu-b2b", async () => {
			await wrapped.invoke({ index: "logs-*" });
		});
		const lastArgs = (original as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs();
		expect(lastArgs).toEqual({ index: "logs-*" });
	});

	// The non-fan-out path runs without a deployment scope; the wrapper must not throw.
	test("does not require a deployment scope", async () => {
		const original = makeJsonSchemaTool("elasticsearch_no_scope_tool");
		const wrapped = wrapElasticToolsWithDeployment([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		await expect(wrapped.invoke({ index: "logs-*" })).resolves.toBeDefined();
	});

	// Defensive: a stale `deployment` arg must be dropped so it can't shadow the header
	// at the MCP server (where an explicit `deployment` arg wins over the header).
	test("drops a deployment arg that slips through before forwarding", async () => {
		const original = makeJsonSchemaTool("elasticsearch_defensive_tool");
		const wrapped = wrapElasticToolsWithDeployment([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		await wrapped.invoke({ index: "logs-*", deployment: "us-cld" });
		const lastArgs = (original as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs();
		expect(lastArgs).toEqual({ index: "logs-*" });
	});
});
