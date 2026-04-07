// shared/src/agent-state.ts
import { z } from "zod";

export const ToolOutputSchema = z.object({
	toolName: z.string(),
	rawJson: z.unknown(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

export const ToolErrorCategorySchema = z.enum(["auth", "session", "transient", "unknown"]);
export type ToolErrorCategory = z.infer<typeof ToolErrorCategorySchema>;

export const ToolErrorSchema = z.object({
	toolName: z.string(),
	category: ToolErrorCategorySchema,
	message: z.string(),
	retryable: z.boolean(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const DataSourceResultSchema = z.object({
	dataSourceId: z.string(),
	data: z.unknown(),
	status: z.enum(["pending", "running", "success", "error"]),
	duration: z.number().optional(),
	toolOutputs: z.array(ToolOutputSchema).optional(),
	isAlignmentRetry: z.boolean().optional(),
	error: z.string().optional(),
	toolErrors: z.array(ToolErrorSchema).optional(),
});
export type DataSourceResult = z.infer<typeof DataSourceResultSchema>;

export const ToolPlanStepSchema = z.object({
	tool: z.string(),
	args: z.record(z.string(), z.unknown()),
});
export type ToolPlanStep = z.infer<typeof ToolPlanStepSchema>;

export const ExtractedEntitiesSchema = z.object({
	dataSources: z.array(
		z.object({
			id: z.string(),
			mentionedAs: z.string(),
		}),
	),
});
export type ExtractedEntities = z.infer<typeof ExtractedEntitiesSchema>;

export const DataSourceContextSchema = z.object({
	type: z.enum(["EXPLICIT", "INHERITED"]),
	dataSources: z.array(z.string()),
	inheritedFrom: z.string().optional(),
	scope: z.enum(["all", "subset", "merged"]),
});
export type DataSourceContext = z.infer<typeof DataSourceContextSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("message"), content: z.string() }),
	z.object({
		type: z.literal("tool_call"),
		toolName: z.string(),
		args: z.record(z.string(), z.unknown()),
		dataSourceId: z.string().optional(),
	}),
	z.object({
		type: z.literal("datasource_progress"),
		dataSourceId: z.string(),
		status: z.enum(["pending", "running", "success", "error"]),
		message: z.string().optional(),
	}),
	z.object({ type: z.literal("node_start"), nodeId: z.string() }),
	z.object({ type: z.literal("node_end"), nodeId: z.string(), duration: z.number() }),
	z.object({ type: z.literal("suggestions"), suggestions: z.array(z.string()) }),
	z.object({
		type: z.literal("done"),
		threadId: z.string(),
		requestId: z.string().optional(),
		runId: z.string().optional(),
		confidence: z.number().optional(),
		responseTime: z.number().optional(),
		toolsUsed: z.array(z.string()).optional(),
		dataSourceContext: DataSourceContextSchema.optional(),
	}),
	z.object({ type: z.literal("error"), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
