// src/tools/output-schemas.ts
import { z } from "zod";

// Mirrors packages/shared/src/tool-error.ts ToolErrorEnvelope's wire shape. Not imported
// directly: server packages don't pull agent-state Zod objects across the package boundary,
// and the envelope's `_error.kind`/`_error.category` are free-form strings on the wire here --
// this schema only needs to accept the shape, not re-validate the shared enum vocabulary.
const ToolErrorEnvelopeSchema = z.object({
	_error: z.object({
		kind: z.string(),
		category: z.string(),
		message: z.string(),
		advice: z.string().optional(),
		statusCode: z.number().optional(),
		hostname: z.string().optional(),
		upstreamContentType: z.string().optional(),
	}),
});

const ConsumerGroupSchema = z.object({
	id: z.string(),
	state: z.string(),
	groupType: z.string(),
	protocolType: z.string(),
});

// listConsumerGroups (operations.ts) returns the bare array from KafkaService.listConsumerGroups
// on success, or a ToolErrorEnvelope (via invalidFilterEnvelope) on a caught InvalidFilterError --
// both paths return through ResponseBuilder.success (isError is never set), so both must
// validate as structuredContent. Two constraints shape this schema:
//   1. The MCP wire format requires structuredContent to be a JSON OBJECT (types.d.ts:
//      ZodRecord<string, unknown> / a loose ZodObject) -- a bare array cannot be assigned
//      directly, so the array branch wraps under `groups`.
//   2. registerTool's outputSchema must resolve to a single ZodObject, not a top-level
//      z.union(...) -- the SDK's normalizeObjectSchema (zod-compat.js) only recognizes a plain
//      object shape or an already-ZodObject instance; a union has no `.shape` and gets
//      misidentified as a raw field-map, crashing at runtime ("s._zod" on a non-schema value).
// So this is one flat object with both branches' fields optional, mirroring the AWS
// describeAlarmsOutputSchema passthrough pattern (output-schemas.ts in mcp-server-aws) rather
// than a discriminated union.
export const ListConsumerGroupsOutputSchema = z.object({
	groups: z.array(ConsumerGroupSchema).optional(),
	_error: ToolErrorEnvelopeSchema.shape._error.optional(),
});

const ConsumerGroupLagPartitionSchema = z.object({
	partition: z.number(),
	committedOffset: z.string(),
	latestOffset: z.string(),
	lag: z.string(),
});

const ConsumerGroupLagTopicSchema = z.object({
	topic: z.string(),
	partitions: z.array(ConsumerGroupLagPartitionSchema),
	totalLag: z.string(),
});

// getConsumerGroupLag (KafkaService) always returns this single shape -- no error-envelope
// branch (operations-extended.ts passes the call through unwrapped).
export const GetConsumerGroupLagOutputSchema = z.object({
	groupId: z.string(),
	groupState: z.string().optional(),
	topics: z.array(ConsumerGroupLagTopicSchema),
	totalLag: z.string(),
});
