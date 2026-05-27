// src/config/schemas.ts
import { z } from "zod";

const roleArnRegex = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;
const estateIdRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const numericString = (def: number) =>
	z.preprocess((v) => (v === undefined || v === "" ? def : Number(v)), z.number().int().positive());

const EstateSchema = z.object({
	assumedRoleArn: z
		.string()
		.regex(roleArnRegex, "Must be a valid IAM role ARN")
		.describe("Target role to assume for this estate"),
	externalId: z.string().min(1).describe("STS ExternalId required by the role's trust policy"),
});

export const ConfigSchema = z.preprocess(
	(raw) => {
		const env = (raw ?? {}) as Record<string, string | undefined>;
		return {
			AWS_REGION: env.AWS_REGION,
			AWS_ESTATES: env.AWS_ESTATES,
			AWS_MCP_LOG_LEVEL: env.AWS_MCP_LOG_LEVEL ?? "info",
			TRANSPORT_MODE: env.MCP_TRANSPORT ?? env.TRANSPORT_MODE ?? "stdio",
			TRANSPORT_PORT: env.MCP_PORT ?? env.TRANSPORT_PORT,
			TRANSPORT_HOST: env.MCP_HOST ?? env.TRANSPORT_HOST ?? "0.0.0.0",
			TRANSPORT_PATH: env.TRANSPORT_PATH ?? "/mcp",
			SUBAGENT_TOOL_RESULT_CAP_BYTES: env.SUBAGENT_TOOL_RESULT_CAP_BYTES,
			SKIP_ESTATE_VALIDATION: env.SKIP_ESTATE_VALIDATION,
		};
	},
	z
		.object({
			AWS_REGION: z.string().min(1).describe("AWS region for SDK clients"),
			AWS_ESTATES: z
				.string()
				.min(1, "AWS_ESTATES is required")
				.transform((raw, ctx) => {
					try {
						return JSON.parse(raw) as unknown;
					} catch (e) {
						ctx.addIssue({
							code: "custom",
							message: `AWS_ESTATES must be valid JSON: ${(e as Error).message}`,
						});
						return z.NEVER;
					}
				})
				.pipe(
					z
						.record(z.string().regex(estateIdRegex, "Estate ID must be lowercase alphanumeric/hyphens"), EstateSchema)
						.refine((map) => Object.keys(map).length >= 1, "At least one estate required"),
				),
			AWS_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
			TRANSPORT_MODE: z.enum(["stdio", "http", "both", "agentcore"]),
			TRANSPORT_PORT: numericString(9085),
			TRANSPORT_HOST: z.string(),
			TRANSPORT_PATH: z.string(),
			SUBAGENT_TOOL_RESULT_CAP_BYTES: numericString(32000),
			SKIP_ESTATE_VALIDATION: z
				.string()
				.optional()
				.transform((v) => v === "true" || v === "1"),
		})
		.transform((raw) => ({
			aws: {
				region: raw.AWS_REGION,
				estates: raw.AWS_ESTATES,
			},
			logLevel: raw.AWS_MCP_LOG_LEVEL,
			transport: {
				mode: raw.TRANSPORT_MODE,
				port: raw.TRANSPORT_PORT,
				host: raw.TRANSPORT_HOST,
				path: raw.TRANSPORT_PATH,
			},
			toolResultCapBytes: raw.SUBAGENT_TOOL_RESULT_CAP_BYTES,
			skipEstateValidation: raw.SKIP_ESTATE_VALIDATION,
		})),
);

export type Config = z.output<typeof ConfigSchema>;
export type AwsConfig = Config["aws"];
export type EstateConfig = z.infer<typeof EstateSchema>;
export type TransportConfig = Config["transport"];
