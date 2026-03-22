// src/tools/schema/parameters.ts
import { z } from "zod";

export const SubjectNameParam = z.string().min(1).describe("Schema subject name (e.g., 'orders-value', 'users-key')");

export const SchemaTypeParam = z
	.enum(["AVRO", "JSON", "PROTOBUF"])
	.optional()
	.describe("Schema type: AVRO (default), JSON, or PROTOBUF");

export const VersionParam = z
	.union([z.number().int().positive(), z.literal("latest")])
	.optional()
	.describe("Schema version number or 'latest' (default: latest)");

export const CompatibilityLevelParam = z
	.enum(["BACKWARD", "BACKWARD_TRANSITIVE", "FORWARD", "FORWARD_TRANSITIVE", "FULL", "FULL_TRANSITIVE", "NONE"])
	.describe("Schema compatibility level");

export const ListSchemasParams = z.object({});

export const GetSchemaParams = z.object({
	subject: SubjectNameParam,
	version: VersionParam,
});

export const GetSchemaVersionsParams = z.object({
	subject: SubjectNameParam,
});

export const RegisterSchemaParams = z.object({
	subject: SubjectNameParam,
	schema: z.string().min(1).describe("Schema definition as a JSON string"),
	schemaType: SchemaTypeParam,
});

export const CheckCompatibilityParams = z.object({
	subject: SubjectNameParam,
	schema: z.string().min(1).describe("Schema definition to test compatibility against"),
	schemaType: SchemaTypeParam,
	version: VersionParam,
});

export const GetSchemaConfigParams = z.object({
	subject: z.string().optional().describe("Subject name. Omit to get global config."),
});

export const SetSchemaConfigParams = z.object({
	subject: z.string().optional().describe("Subject name. Omit to set global config."),
	compatibilityLevel: CompatibilityLevelParam,
});

export const DeleteSchemaSubjectParams = z.object({
	subject: SubjectNameParam,
	permanent: z.boolean().optional().describe("Permanently delete (hard delete). Default: false (soft delete)."),
});
