import { describe, expect, test } from "bun:test";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { wrapAwsToolsWithEstate } from "./aws-tool-estate-wrapper.ts";
import { withAwsEstate } from "./mcp-bridge.ts";

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
			schema: {
				type: "object",
				properties: {
					estate: { type: "string" },
					cluster: { type: "string" },
				},
				required: ["estate", "cluster"],
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
			schema: z.object({ estate: z.string(), cluster: z.string() }),
		},
	) as unknown as StructuredToolInterface;
	(tool as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs = () => lastArgs;
	return tool;
}

// The real aws_list_estates is zero-arg and estate-independent (mcp-server-aws
// list-estates.ts: z.object({})). Mirror that shape for the exemption tests.
function makeListEstatesTool(): StructuredToolInterface {
	let lastArgs: Record<string, unknown> | undefined;
	const tool = createTool(
		async (args) => {
			lastArgs = args as Record<string, unknown>;
			return JSON.stringify({ estates: [{ id: "eu-prd" }, { id: "us-prd" }] });
		},
		{ name: "aws_list_estates", description: "list estates", schema: z.object({}) },
	) as unknown as StructuredToolInterface;
	(tool as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs = () => lastArgs;
	return tool;
}

describe("wrapAwsToolsWithEstate (SIO-832)", () => {
	test("strips estate from JSON Schema properties and required", () => {
		const original = makeJsonSchemaTool("aws_test_tool");
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		const schema = wrapped.schema as { properties: Record<string, unknown>; required?: string[] };
		expect(schema.properties).not.toHaveProperty("estate");
		expect(schema.properties).toHaveProperty("cluster");
		expect(schema.required).toEqual(["cluster"]);
	});

	test("strips estate from a Zod object schema", () => {
		const original = makeZodTool("aws_zod_tool");
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		const shape = (wrapped.schema as z.ZodObject<z.ZodRawShape>).shape;
		expect("estate" in shape).toBe(false);
		expect("cluster" in shape).toBe(true);
	});

	test("injects estate from ALS at invocation time", async () => {
		const original = makeJsonSchemaTool("aws_inject_tool");
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		await withAwsEstate("eu-test-prd", async () => {
			await wrapped.invoke({ cluster: "my-cluster" });
		});
		const lastArgs = (original as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs();
		expect(lastArgs).toEqual({ cluster: "my-cluster", estate: "eu-test-prd" });
	});

	test("throws when invoked outside withAwsEstate scope", async () => {
		const original = makeJsonSchemaTool("aws_no_scope_tool");
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		await expect(wrapped.invoke({ cluster: "my-cluster" })).rejects.toThrow(/outside withAwsEstate scope/);
	});

	// SIO-1114: aws_list_estates is estate-independent (SIO-854 reconciliation calls
	// it before any per-estate fan-out). The guard must NOT fire for it.
	test("aws_list_estates invoked outside any scope does not throw", async () => {
		const original = makeListEstatesTool();
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		// No withAwsEstate scope here -- an estate-scoped tool would throw; this must not.
		const result = await wrapped.invoke({});
		expect(result).toContain("estates");
	});

	test("aws_list_estates is returned untouched (no estate injected, args passthrough)", async () => {
		const original = makeListEstatesTool();
		const wrapped = wrapAwsToolsWithEstate([original])[0];
		if (!wrapped) throw new Error("wrapper returned no tools");
		expect(wrapped).toBe(original); // exempt tools are returned as-is, not re-wrapped
		await wrapped.invoke({});
		const lastArgs = (original as unknown as { _lastArgs: () => Record<string, unknown> | undefined })._lastArgs();
		expect(lastArgs).toEqual({}); // no estate injected
	});
});
