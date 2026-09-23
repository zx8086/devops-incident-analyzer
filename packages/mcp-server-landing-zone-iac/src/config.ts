import { z } from "zod";

const PathPrefixSchema = z
	.string()
	.min(1)
	.max(500)
	.refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "path prefix must be relative");

export const ConfigSchema = z
	.object({
		transport: z.object({
			mode: z.enum(["http", "stdio"]),
			port: z.number().int().positive(),
			host: z.string().min(1),
			path: z.string().startsWith("/"),
		}),
		gitlab: z.object({
			baseUrl: z.string().url(),
			token: z.string().min(1).optional(),
			timeoutMs: z.number().int().positive(),
			maxResponseBytes: z.number().int().min(1_024).max(2_000_000),
		}),
		write: z.object({
			enabled: z.boolean(),
			token: z.string().min(1).optional(),
			reviewSecret: z.string().min(32).optional(),
			allowedProjects: z.array(z.string().min(1)),
			allowedPathPrefixes: z.record(z.string(), z.array(PathPrefixSchema).min(1)),
			backendProjects: z.array(z.string().min(1)),
		}),
	})
	.superRefine((config, context) => {
		if (!config.write.enabled) return;
		if (!config.write.token)
			context.addIssue({ code: "custom", path: ["write", "token"], message: "write token is required" });
		if (config.write.token && config.write.token === config.gitlab.token) {
			context.addIssue({
				code: "custom",
				path: ["write", "token"],
				message: "write token must be separate from the read credential",
			});
		}
		if (!config.write.reviewSecret)
			context.addIssue({
				code: "custom",
				path: ["write", "reviewSecret"],
				message: "review signing secret is required",
			});
		if (config.write.reviewSecret && config.write.reviewSecret === config.write.token) {
			context.addIssue({
				code: "custom",
				path: ["write", "reviewSecret"],
				message: "review signing secret must be separate from the GitLab write credential",
			});
		}
		if (config.write.allowedProjects.length === 0)
			context.addIssue({ code: "custom", path: ["write", "allowedProjects"], message: "write allowlist is required" });
		for (const project of config.write.allowedProjects) {
			if (!config.write.allowedPathPrefixes[project]?.length) {
				context.addIssue({
					code: "custom",
					path: ["write", "allowedPathPrefixes", project],
					message: "every writable project requires an allowed path prefix",
				});
			}
		}
		for (const project of config.write.backendProjects) {
			if (!config.write.allowedProjects.includes(project)) {
				context.addIssue({
					code: "custom",
					path: ["write", "backendProjects"],
					message: "backend projects must also be write-allowlisted",
				});
			}
		}
	});

export type Config = z.infer<typeof ConfigSchema>;

function commaList(value: string | undefined): string[] {
	return [
		...new Set(
			(value ?? "")
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}

function pathAllowlist(value: string | undefined): unknown {
	if (!value) return {};
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
	return ConfigSchema.parse({
		transport: {
			mode: (env.LANDING_ZONE_IAC_MCP_TRANSPORT as "http" | "stdio") ?? "http",
			port: Number(env.LANDING_ZONE_IAC_MCP_PORT ?? "9088"),
			host: env.LANDING_ZONE_IAC_MCP_HOST ?? "0.0.0.0",
			path: env.LANDING_ZONE_IAC_MCP_PATH ?? "/mcp",
		},
		gitlab: {
			baseUrl: env.GITLAB_BASE_URL ?? "https://gitlab.com",
			token: env.GITLAB_PERSONAL_ACCESS_TOKEN || undefined,
			timeoutMs: Number(env.LANDING_ZONE_IAC_GITLAB_TIMEOUT_MS ?? "30000"),
			maxResponseBytes: Number(env.LANDING_ZONE_IAC_MAX_RESPONSE_BYTES ?? "200000"),
		},
		write: {
			enabled: env.LANDING_ZONE_WRITE_ENABLED === "true",
			token: env.LANDING_ZONE_GITLAB_WRITE_TOKEN || undefined,
			reviewSecret: env.LANDING_ZONE_WRITE_REVIEW_SECRET || undefined,
			allowedProjects: commaList(env.LANDING_ZONE_WRITE_PROJECTS),
			allowedPathPrefixes: pathAllowlist(env.LANDING_ZONE_WRITE_PATHS),
			backendProjects: commaList(env.LANDING_ZONE_WRITE_BACKEND_PROJECTS),
		},
	});
}
