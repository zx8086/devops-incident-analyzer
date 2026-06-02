// packages/agent/src/strip-tool-schema-field.ts

import { getLogger } from "@devops-agent/observability";
import { z } from "zod";

const logger = getLogger("strip-tool-schema-field");

// SIO-832: MultiServerMCPClient hands tool schemas back as raw JSON Schema objects,
// not Zod instances, so an `instanceof z.ZodObject` check alone fails silently and
// leaves the field visible to the LLM. Duck-type both shapes and strip the named
// field before re-registering. Shared by the AWS estate (SIO-828) and elastic
// deployment fan-out wrappers so the strip logic lives in exactly one place.

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

function stripFromJsonSchema(schema: JsonSchemaObject, field: string): JsonSchemaObject {
	const { [field]: _dropped, ...remainingProperties } = (schema.properties ?? {}) as Record<string, unknown>;
	const remainingRequired = Array.isArray(schema.required) ? schema.required.filter((k) => k !== field) : undefined;
	const next: JsonSchemaObject = { ...schema, properties: remainingProperties };
	if (remainingRequired !== undefined) next.required = remainingRequired;
	return next;
}

function stripFromZodObject(schema: z.ZodObject<z.ZodRawShape>, field: string): z.ZodObject<z.ZodRawShape> {
	const shape = { ...(schema.shape as z.ZodRawShape) };
	delete shape[field];
	return z.object(shape);
}

export type StrippedSchema = z.ZodObject<z.ZodRawShape> | JsonSchemaObject;

export function stripToolSchemaField(schema: unknown, field: string): StrippedSchema {
	if (schema instanceof z.ZodObject) {
		return stripFromZodObject(schema, field);
	}
	if (isJsonSchemaObject(schema)) {
		return stripFromJsonSchema(schema, field);
	}
	logger.warn(
		{ field, schemaType: (schema as { constructor?: { name?: string } })?.constructor?.name },
		"Tool schema is neither ZodObject nor JSON Schema; falling back to empty passthrough",
	);
	return z.object({}).passthrough();
}
