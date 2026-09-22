import { z } from "zod";

export const ConfigSchema = z.object({
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
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
	return ConfigSchema.parse({
		transport: {
			mode: (Bun.env.LANDING_ZONE_IAC_MCP_TRANSPORT as "http" | "stdio") ?? "http",
			port: Number(Bun.env.LANDING_ZONE_IAC_MCP_PORT ?? "9088"),
			host: Bun.env.LANDING_ZONE_IAC_MCP_HOST ?? "0.0.0.0",
			path: Bun.env.LANDING_ZONE_IAC_MCP_PATH ?? "/mcp",
		},
		gitlab: {
			baseUrl: Bun.env.GITLAB_BASE_URL ?? "https://gitlab.com",
			token: Bun.env.GITLAB_PERSONAL_ACCESS_TOKEN || undefined,
			timeoutMs: Number(Bun.env.LANDING_ZONE_IAC_GITLAB_TIMEOUT_MS ?? "30000"),
			maxResponseBytes: Number(Bun.env.LANDING_ZONE_IAC_MAX_RESPONSE_BYTES ?? "200000"),
		},
	});
}
