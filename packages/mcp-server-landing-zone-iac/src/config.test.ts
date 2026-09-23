import { describe, expect, test } from "bun:test";
import { ConfigSchema, loadConfig } from "./config.ts";

describe("Landing Zone MCP config", () => {
	test("uses a dedicated local port and the shared GitLab endpoint", () => {
		const config = loadConfig();
		expect(config.transport.port).toBe(9088);
		expect(config.transport.path).toBe("/mcp");
		expect(config.gitlab.baseUrl).toBe("https://gitlab.com");
		expect(config.gitlab.maxResponseBytes).toBe(200_000);
		expect(config.write.enabled).toBe(false);
		expect(config.write.allowedProjects).toEqual([]);
	});

	test("requires separate credentials, review token, projects, and paths when write mode is enabled", () => {
		const base = {
			transport: { mode: "http", port: 9088, host: "127.0.0.1", path: "/mcp" },
			gitlab: { baseUrl: "https://gitlab.example", token: "read-token", timeoutMs: 30_000, maxResponseBytes: 200_000 },
		};
		expect(
			ConfigSchema.safeParse({
				...base,
				write: {
					enabled: true,
					allowedProjects: [],
					allowedPathPrefixes: {},
					backendProjects: [],
				},
			}).success,
		).toBe(false);
		expect(
			ConfigSchema.safeParse({
				...base,
				write: {
					enabled: true,
					token: "write-token",
					reviewToken: "review-token",
					allowedProjects: ["pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator"],
					allowedPathPrefixes: {
						"pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator": ["accounts/"],
					},
					backendProjects: [],
				},
			}).success,
		).toBe(true);
		expect(
			ConfigSchema.safeParse({
				...base,
				write: {
					enabled: true,
					token: "read-token",
					reviewToken: "review-token",
					allowedProjects: ["pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator"],
					allowedPathPrefixes: {
						"pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator": ["accounts/"],
					},
					backendProjects: [],
				},
			}).success,
		).toBe(false);
	});

	test("loads explicit write allowlists without enabling on truthy lookalikes", () => {
		const env = {
			LANDING_ZONE_WRITE_ENABLED: "TRUE",
			LANDING_ZONE_GITLAB_WRITE_TOKEN: "write-token",
			LANDING_ZONE_WRITE_REVIEW_TOKEN: "review-token",
			LANDING_ZONE_WRITE_PROJECTS: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator",
			LANDING_ZONE_WRITE_PATHS: '{"pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator":["accounts/"]}',
		};
		expect(loadConfig(env).write.enabled).toBe(false);
		expect(loadConfig({ ...env, LANDING_ZONE_WRITE_ENABLED: "true" }).write).toMatchObject({
			enabled: true,
			token: "write-token",
			reviewToken: "review-token",
			allowedProjects: ["pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator"],
		});
	});
});
