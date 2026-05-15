// src/config/schemas.ts
import { z } from "zod";

const roleArnRegex = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;

const numericString = (def: number) =>
	z.preprocess((v) => (v === undefined || v === "" ? def : Number(v)), z.number().int().positive());

export const ConfigSchema = z.preprocess(
	(raw) => {
		const env = (raw ?? {}) as Record<string, string | undefined>;
		return {
			AWS_REGION: env.AWS_REGION,
			AWS_ASSUMED_ROLE_ARN: env.AWS_ASSUMED_ROLE_ARN,
			AWS_EXTERNAL_ID: env.AWS_EXTERNAL_ID,
			AWS_MCP_LOG_LEVEL: env.AWS_MCP_LOG_LEVEL ?? "info",
			TRANSPORT_MODE: env.MCP_TRANSPORT ?? env.TRANSPORT_MODE ?? "stdio",
			TRANSPORT_PORT: env.MCP_PORT ?? env.TRANSPORT_PORT,
			TRANSPORT_HOST: env.MCP_HOST ?? env.TRANSPORT_HOST ?? "0.0.0.0",
			TRANSPORT_PATH: env.TRANSPORT_PATH ?? "/mcp",
			SUBAGENT_TOOL_RESULT_CAP_BYTES: env.SUBAGENT_TOOL_RESULT_CAP_BYTES,
		};
	},
	z
		.object({
			AWS_REGION: z.string().min(1).describe("AWS region for SDK clients"),
			AWS_ASSUMED_ROLE_ARN: z
				.string()
				.regex(roleArnRegex, "Must be a valid IAM role ARN")
				.describe("Role to assume for AWS API calls"),
			AWS_EXTERNAL_ID: z.string().min(1).describe("STS ExternalId for the AssumeRole condition"),
			AWS_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
			TRANSPORT_MODE: z.enum(["stdio", "http", "both", "agentcore"]),
			TRANSPORT_PORT: numericString(9085),
			TRANSPORT_HOST: z.string(),
			TRANSPORT_PATH: z.string(),
			SUBAGENT_TOOL_RESULT_CAP_BYTES: numericString(32000),
		})
		.transform((raw) => ({
			aws: {
				region: raw.AWS_REGION,
				assumedRoleArn: raw.AWS_ASSUMED_ROLE_ARN,
				externalId: raw.AWS_EXTERNAL_ID,
			},
			logLevel: raw.AWS_MCP_LOG_LEVEL,
			transport: {
				mode: raw.TRANSPORT_MODE,
				port: raw.TRANSPORT_PORT,
				host: raw.TRANSPORT_HOST,
				path: raw.TRANSPORT_PATH,
			},
			toolResultCapBytes: raw.SUBAGENT_TOOL_RESULT_CAP_BYTES,
		})),
);

export type Config = z.output<typeof ConfigSchema>;
export type AwsConfig = Config["aws"];
export type TransportConfig = Config["transport"];
