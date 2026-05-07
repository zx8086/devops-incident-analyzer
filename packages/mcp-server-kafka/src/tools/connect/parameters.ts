// src/tools/connect/parameters.ts
import { z } from "zod";

export const ConnectGetClusterInfoParams = z.object({});

export const ConnectListConnectorsParams = z.object({});

export const ConnectGetConnectorStatusParams = z.object({
	name: z.string().min(1).describe("Connector name"),
});

export const ConnectGetConnectorTaskStatusParams = z.object({
	name: z.string().min(1).describe("Connector name"),
	taskId: z.number().int().min(0).describe("Task ID (0-indexed)"),
});
