// packages/agent/src/aws-tool-estate-wrapper.ts

import { getLogger } from "@devops-agent/observability";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { currentAwsEstate } from "./mcp-bridge.ts";

const logger = getLogger("aws-tool-estate-wrapper");

// SIO-832: MultiServerMCPClient hands tool schemas back as raw JSON Schema objects,
// not Zod instances. The previous `instanceof z.ZodObject` check failed silently on
// every AWS tool, leaving `estate` visible to the LLM and defeating SIO-828's design.
// This duck-types both shapes and strips `estate` from each before re-registering.

type JsonSchemaObject = {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
};

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
	if (schema === null || typeof schema !== "object") return false;
	const s = schema as JsonSchemaObject;
	// JSON Schema for an object tool always has properties; type may be omitted by some emitters.
	return s.properties !== undefined && typeof s.properties === "object";
}

function stripEstateFromJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
	const { estate: _dropped, ...remainingProperties } = (schema.properties ?? {}) as Record<string, unknown>;
	const remainingRequired = Array.isArray(schema.required) ? schema.required.filter((k) => k !== "estate") : undefined;
	const next: JsonSchemaObject = { ...schema, properties: remainingProperties };
	if (remainingRequired !== undefined) next.required = remainingRequired;
	return next;
}

function stripEstateFromZodObject(schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
	const shape = { ...(schema.shape as z.ZodRawShape) };
	delete shape.estate;
	return z.object(shape);
}

type StrippedSchema = z.ZodObject<z.ZodRawShape> | JsonSchemaObject;

function stripEstate(schema: unknown): StrippedSchema {
	if (schema instanceof z.ZodObject) {
		return stripEstateFromZodObject(schema);
	}
	if (isJsonSchemaObject(schema)) {
		return stripEstateFromJsonSchema(schema);
	}
	logger.warn(
		{ schemaType: (schema as { constructor?: { name?: string } })?.constructor?.name },
		"AWS tool schema is neither ZodObject nor JSON Schema; falling back to empty passthrough",
	);
	return z.object({}).passthrough();
}

export function wrapAwsToolsWithEstate(awsTools: StructuredToolInterface[]): StructuredToolInterface[] {
	return awsTools.map((original) => {
		const strippedSchema = stripEstate(original.schema);

		return createTool(
			async (args: unknown) => {
				const estate = currentAwsEstate();
				if (!estate) {
					// The fan-out wrapper in queryDataSource is the only legitimate
					// caller path; missing context is a programming error worth surfacing.
					throw new Error(
						`AWS tool "${original.name}" invoked outside withAwsEstate scope. ` +
							"This indicates a bug in the AWS sub-agent fan-out.",
					);
				}
				const withEstate = { ...(args as Record<string, unknown>), estate };
				return original.invoke(withEstate);
			},
			{
				name: original.name,
				description: original.description ?? `${original.name} tool`,
				// biome-ignore lint/suspicious/noExplicitAny: SIO-832 - createTool's union of Zod/JsonSchema7Type is too tight to satisfy with a runtime-branched schema
				schema: strippedSchema as any,
				// SIO-853: surface the exact schema-mismatch field to the LLM + logs instead of
				// the bare "did not match expected schema". Cheap permanent diagnostic so a future
				// estate/schema drift names the offending field rather than failing opaquely.
				verboseParsingErrors: true,
			},
		) as unknown as StructuredToolInterface;
	});
}
