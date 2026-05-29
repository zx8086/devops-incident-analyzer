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
	// SIO-832: optional per-estate region override. When absent, the global AWS_REGION is used.
	// Required for estates whose workloads live outside the default region (e.g. eu-b2bonboarding-prd in eu-west-1).
	region: z.string().min(1).optional().describe("Optional region override; falls back to AWS_REGION"),
});

export const ConfigSchema = z.preprocess(
	(raw) => {
		const env = (raw ?? {}) as Record<string, string | undefined>;
		return {
			AWS_REGION: env.AWS_REGION,
			AWS_ESTATES: env.AWS_ESTATES,
			AWS_MCP_LOG_LEVEL: env.AWS_MCP_LOG_LEVEL ?? "info",
			// SIO-828: 4-pillar -- defaults must produce a working deployment.
			// The production target for this image is AgentCore, so the schema
			// default is `agentcore` + port 8000. Local CLI usage explicitly sets
			// MCP_TRANSPORT=stdio. Loading the tarball into AgentCore with only
			// AWS_REGION + AWS_ESTATES set produces a working runtime.
			TRANSPORT_MODE: env.MCP_TRANSPORT ?? env.TRANSPORT_MODE ?? "agentcore",
			TRANSPORT_PORT: env.MCP_PORT ?? env.TRANSPORT_PORT,
			TRANSPORT_HOST: env.MCP_HOST ?? env.TRANSPORT_HOST ?? "0.0.0.0",
			TRANSPORT_PATH: env.TRANSPORT_PATH ?? "/mcp",
			SUBAGENT_TOOL_RESULT_CAP_BYTES: env.SUBAGENT_TOOL_RESULT_CAP_BYTES,
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
			// SIO-828: 8000 is the AgentCore-required port and the production
			// default for this image. HTTP-mode local dev that needs a different
			// port sets MCP_PORT explicitly.
			TRANSPORT_PORT: numericString(8000),
			TRANSPORT_HOST: z.string(),
			TRANSPORT_PATH: z.string(),
			SUBAGENT_TOOL_RESULT_CAP_BYTES: numericString(65536),
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
		})),
);

export type Config = z.output<typeof ConfigSchema>;
export type AwsConfig = Config["aws"];
export type EstateConfig = z.infer<typeof EstateSchema>;
export type TransportConfig = Config["transport"];
