// shared/src/config.ts
import { z } from "zod";

export const AgentConfigSchema = z.object({
	llm: z.object({
		model: z.string(),
		haikuModel: z.string().optional(),
		region: z.string(),
	}),
	mcp: z.object({
		elasticUrl: z.string().url().optional(),
		kafkaUrl: z.string().url().optional(),
		capellaUrl: z.string().url().optional(),
		konnectUrl: z.string().url().optional(),
	}),
	checkpointer: z.object({
		type: z.enum(["memory", "sqlite"]),
		sqlitePath: z.string().optional(),
	}),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ServerConfigSchema = z.object({
	port: z.number().positive(),
	host: z.string(),
	cors: z.object({
		origins: z.array(z.string()),
	}),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const SlackConfigSchema = z.object({
	botToken: z.string().startsWith("xoxb-"),
	defaultChannel: z.string(),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

export const LinearConfigSchema = z.object({
	apiKey: z.string().startsWith("lin_api_"),
	teamId: z.string(),
	projectId: z.string(),
});
export type LinearConfig = z.infer<typeof LinearConfigSchema>;

// SIO-1635: pi-coms hub client config. One hub per environment (no cross-environment
// access, user decision 2026-09-06); the estate name suffix selects the hub. No
// .default() here (project rule); defaults are applied in resolvePiComsConfig
// (packages/agent/src/action-tools/pi-coms-client.ts).
export const PiComsEnvironmentSchema = z.enum(["dev", "stg", "prd"]);
export type PiComsEnvironment = z.infer<typeof PiComsEnvironmentSchema>;

export const PiComsHubConfigSchema = z.object({
	serverUrl: z.string().url(),
	authToken: z.string().min(1),
	project: z.string().min(1),
	fallbackTarget: z.string().min(1),
});
export type PiComsHubConfig = z.infer<typeof PiComsHubConfigSchema>;

export const PiComsConfigSchema = z.object({
	hubs: z
		.partialRecord(PiComsEnvironmentSchema, PiComsHubConfigSchema)
		.refine((hubs) => Object.keys(hubs).length > 0, { message: "at least one hub must be configured" }),
	estateAgentMap: z.record(z.string(), z.string()),
	verifyTimeoutMs: z.number().int().positive(),
	investigateTimeoutMs: z.number().int().positive(),
});
export type PiComsConfig = z.infer<typeof PiComsConfigSchema>;
