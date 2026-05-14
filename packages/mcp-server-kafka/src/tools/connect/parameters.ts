// src/tools/connect/parameters.ts
import { z } from "zod";

export const ConnectGetClusterInfoParams = z.object({});

// SIO-742: no-parameter health probe.
export const ConnectHealthCheckParams = z.object({});

export const ConnectListConnectorsParams = z.object({});

export const ConnectGetConnectorStatusParams = z.object({
	name: z.string().min(1).describe("Connector name"),
});

export const ConnectGetConnectorTaskStatusParams = z.object({
	name: z.string().min(1).describe("Connector name"),
	taskId: z.number().int().min(0).describe("Task ID (0-indexed)"),
});

export const ConnectPauseConnectorParams = z.object({
	name: z.string().min(1).describe("Connector name to pause"),
});

export const ConnectResumeConnectorParams = z.object({
	name: z.string().min(1).describe("Connector name to resume"),
});

export const ConnectRestartConnectorParams = z.object({
	name: z.string().min(1).describe("Connector name to restart"),
	includeTasks: z.boolean().optional().describe("Whether to also restart the connector's tasks. Default: false."),
	onlyFailed: z
		.boolean()
		.optional()
		.describe("If includeTasks is true, restart only FAILED tasks instead of all. Default: false."),
});

export const ConnectRestartConnectorTaskParams = z.object({
	name: z.string().min(1).describe("Connector name owning the task"),
	taskId: z.number().int().nonnegative().describe("Task ID to restart"),
});

export const ConnectDeleteConnectorParams = z.object({
	name: z.string().min(1).describe("Connector name to delete (irreversible)"),
});
